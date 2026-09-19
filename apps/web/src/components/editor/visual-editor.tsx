'use client';

import type { CalloutKind } from '@clewwiki/content/callouts';
import { Extension } from '@tiptap/core';
import type { Editor, JSONContent, Range } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { filterBlockItems } from './block-items';
import type { BlockItem, BlockItemActions } from './block-items';
import { ImageDialog, LinkDialog, MermaidDialog, SourceDialog } from './block-dialogs';
import { ChartDialog } from './chart-dialog';
import { createCursorExtension } from './collab/cursors';
import { COLLAB_FIELD } from './collab/initial-state';
import type { SessionProvider } from './collab/provider';
import { insertChart, insertMermaid, setLink } from './commands';
import { bindDocument, parseMarkdown, serializeDocument } from './markdown-bridge';
import type { ParsedMarkdown } from './markdown-bridge';
import { ChartBlockView, EditorUiContext, MermaidBlockView, RawBlockView, RawInlineView } from './node-views';
import type { EditorUi } from './node-views';
import { cleanPastedHtml, looksLikeMarkdown } from './paste';
import { createEditorExtensions } from './schema';
import { CLOSED_SLASH_MENU, createSlashCommand, SlashMenu } from './slash-menu';
import type { SlashMenuState } from './slash-menu';
import { Toolbar } from './toolbar';
import { altFromFileName, imageFilesOf, uploadImage } from './upload-image';
import type { ImageUploadError } from './upload-image';

/**
 * The visual editor: a word-processor surface over a Markdown page.
 *
 * It is handed Markdown and gives Markdown back — the document in between is
 * a working copy. On open it checks that it can hand the page back byte for
 * byte; when it cannot, it says so through `onUnsafe` and the page is edited
 * as Markdown instead of being silently reformatted.
 */

export interface VisualEditorHandle {
  getMarkdown: () => string;
}

export interface VisualEditorProps {
  markdown: string;
  handleRef: RefObject<VisualEditorHandle | null>;
  /** Called, debounced, with the page as Markdown after each edit. */
  onChange: (markdown: string) => void;
  /** Called on open when the page cannot be kept byte for byte. */
  onUnsafe: () => void;
  /** Called once the page is open, with how many blocks are kept as source. */
  onReady: (details: { rawBlocks: number }) => void;
  ariaLabel: string;
  describedBy?: string;
  /**
   * A live session to edit in. The document then comes from the session and not
   * from `markdown`, and `parsed` — the saved page bound to itself — is what
   * unchanged blocks are written back from. It changes whenever anybody saves.
   */
  session?: { provider: SessionProvider; parsed: ParsedMarkdown; editable: boolean };
  /** Where image files are uploaded. Without it, pasted and dropped files are ignored. */
  imageUploadEndpoint?: string;
}

type DialogState =
  | { kind: 'none' }
  | { kind: 'link'; href: string }
  | { kind: 'image' }
  | { kind: 'mermaid'; source: string | null; save: (source: string) => void }
  | { kind: 'chart'; source: string | null; save: (source: string) => void }
  | { kind: 'source'; source: string; save: (source: string) => void };

/**
 * The editor's plumbing between ProseMirror plugins and React state.
 *
 * Plugins are created once, with the editor; the React callbacks they reach
 * change on every render. The controller is the one long-lived object both
 * sides hold: React connects its latest callbacks after each render, and the
 * plugins call through it when a key is pressed or a menu item chosen.
 */
class EditorController {
  editor: Editor | null = null;
  slash: SlashMenuState = CLOSED_SLASH_MENU;
  private setSlashState: (state: SlashMenuState) => void = () => undefined;
  private labelOf: (item: BlockItem) => string = (item) => item.labelKey;
  private actions: BlockItemActions = { openImage: () => undefined, openMermaid: () => undefined, openChart: () => undefined };
  private openLinkDialog: () => void = () => undefined;
  private handlers: Pick<VisualEditorProps, 'onChange' | 'onUnsafe' | 'onReady'> = {
    onChange: () => undefined,
    onUnsafe: () => undefined,
    onReady: () => undefined,
  };
  private changeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Stable functions for the toolbar, delegating to the latest actions. */
  readonly blockActions: BlockItemActions = {
    openImage: () => this.actions.openImage(),
    openMermaid: () => this.actions.openMermaid(),
    openChart: () => this.actions.openChart(),
  };

  connect(options: {
    setSlashState: (state: SlashMenuState) => void;
    labelOf: (item: BlockItem) => string;
    actions: BlockItemActions;
    openLink: () => void;
    handlers: Pick<VisualEditorProps, 'onChange' | 'onUnsafe' | 'onReady'>;
  }): void {
    this.setSlashState = options.setSlashState;
    this.labelOf = options.labelOf;
    this.actions = options.actions;
    this.openLinkDialog = options.openLink;
    this.handlers = options.handlers;
  }

  attach(editor: Editor | null): void {
    this.editor = editor;
  }

  updateSlash = (next: SlashMenuState | ((previous: SlashMenuState) => SlashMenuState)): void => {
    this.slash = typeof next === 'function' ? next(this.slash) : next;
    this.setSlashState(this.slash);
  };

  chooseBlock = (editor: Editor, range: Range, item: BlockItem): void => {
    editor.chain().focus().deleteRange(range).run();
    this.updateSlash(CLOSED_SLASH_MENU);
    item.run(editor, this.blockActions);
  };

  openLink = (): void => this.openLinkDialog();

  created(parsed: ParsedMarkdown, markdown: string, editor: Editor, shared: boolean): void {
    if (shared) {
      // The shared document may already differ from the saved page — that is
      // what other people's edits are — so there is nothing to compare it with.
      // Whether this page can be kept byte for byte was settled from the page
      // itself before the session was offered at all.
      this.handlers.onReady({ rawBlocks: parsed.rawBlocks });
      return;
    }
    const current = editor.getJSON();
    const bound = bindDocument(parsed, current);
    if (!bound || serializeDocument(current, parsed) !== markdown) {
      this.handlers.onUnsafe();
      return;
    }
    this.handlers.onReady({ rawBlocks: parsed.rawBlocks });
  }

  updated(parsed: { current: ParsedMarkdown }, editor: Editor): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.handlers.onChange(serializeDocument(editor.getJSON(), parsed.current));
    }, 250);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
  }

  createExtensions(calloutLabels: Partial<Record<CalloutKind, string>>, provider?: SessionProvider) {
    return [
      ...(provider
        ? [Collaboration.configure({ document: provider.doc, field: COLLAB_FIELD }), createCursorExtension(provider)]
        : []),
      ...createEditorExtensions({
        history: provider === undefined,
        mermaidBlock: ReactNodeViewRenderer(MermaidBlockView),
        chartBlock: ReactNodeViewRenderer(ChartBlockView),
        rawBlock: ReactNodeViewRenderer(RawBlockView),
        rawInline: ReactNodeViewRenderer(RawInlineView),
        calloutLabels,
      }),
      createSlashCommand({
        items: (query) => filterBlockItems(query, (item) => this.labelOf(item)),
        update: this.updateSlash,
        current: () => this.slash,
        choose: this.chooseBlock,
      }),
      Extension.create({
        name: 'linkShortcut',
        addKeyboardShortcuts: () => ({
          'Mod-k': () => {
            this.openLink();
            return true;
          },
        }),
      }),
    ];
  }

  /** Markdown pasted as plain text keeps its structure. */
  pasteMarkdown(text: string): boolean {
    const editor = this.editor;
    if (!editor) return false;
    const pasted = parseMarkdown(text).doc.content ?? [];
    return editor.chain().focus().insertContent(pasted as JSONContent[]).run();
  }
}

export default function VisualEditor({
  markdown,
  handleRef,
  onChange,
  onUnsafe,
  onReady,
  ariaLabel,
  describedBy,
  session,
  imageUploadEndpoint,
}: VisualEditorProps) {
  const t = useTranslations('editor');
  const [uploadNotice, setUploadNotice] = useState<ImageUploadError | 'uploading' | null>(null);
  // The editor's props are read once, when it is created; what a paste or a
  // drop should do is looked up through this at the moment it happens.
  const uploadFiles = useRef<(files: File[], position?: number) => boolean>(() => false);
  const tc = useTranslations('content');
  const [ownParsed] = useState<ParsedMarkdown>(() => session?.parsed ?? parseMarkdown(markdown));
  // In a session the base moves under the editor each time somebody saves.
  const parsedRef = useRef(ownParsed);
  useEffect(() => {
    parsedRef.current = session?.parsed ?? ownParsed;
  }, [session?.parsed, ownParsed]);
  const [provider] = useState(() => session?.provider);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [slash, setSlash] = useState<SlashMenuState>(CLOSED_SLASH_MENU);
  const [controller] = useState(() => new EditorController());
  const [extensions] = useState(() =>
    controller.createExtensions(
      {
        NOTE: tc('calloutNote'),
        TIP: tc('calloutTip'),
        IMPORTANT: tc('calloutImportant'),
        WARNING: tc('calloutWarning'),
        CAUTION: tc('calloutCaution'),
      },
      provider,
    ),
  );

  const editor = useEditor({
    extensions,
    // A shared document is filled by the session, never from here: setting
    // content as well would type the page into it a second time.
    ...(provider ? {} : { content: ownParsed.doc }),
    editable: session?.editable ?? true,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'markdown-body visual-editor-body',
        'aria-label': ariaLabel,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        spellcheck: 'true',
      },
      transformPastedHTML: cleanPastedHtml,
      handlePaste: (view, event) => {
        const html = event.clipboardData?.getData('text/html') ?? '';
        const text = event.clipboardData?.getData('text/plain') ?? '';
        // A screenshot, or a picture copied out of another program: files and no
        // text. Copied text that merely comes with a rendering of itself is text.
        const files = imageFilesOf(event.clipboardData);
        if (files.length > 0 && text.trim() === '') return uploadFiles.current(files);
        if (html.trim() !== '' || !looksLikeMarkdown(text)) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false;
        return controller.pasteMarkdown(text);
      },
      handleDrop: (view, event, _slice, moved) => {
        // `moved` is a drag inside the document, which is the editor's own business.
        if (moved) return false;
        const files = imageFilesOf(event.dataTransfer);
        if (files.length === 0) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return uploadFiles.current(files, at);
      },
    },
    onCreate: ({ editor: created }) =>
      controller.created(parsedRef.current, markdown, created, provider !== undefined),
    onUpdate: ({ editor: updated }) => controller.updated(parsedRef, updated),
  });

  useEffect(() => {
    controller.connect({
      setSlashState: setSlash,
      labelOf: (item) => t(item.labelKey),
      handlers: { onChange, onUnsafe, onReady },
      openLink: () => {
        const current = controller.editor;
        if (!current) return;
        setDialog({ kind: 'link', href: String(current.getAttributes('link').href ?? '') });
      },
      actions: {
        openImage: () => setDialog({ kind: 'image' }),
        openMermaid: () =>
          setDialog({
            kind: 'mermaid',
            source: null,
            save: (source) => {
              if (controller.editor) insertMermaid(controller.editor, source);
            },
          }),
        openChart: () =>
          setDialog({
            kind: 'chart',
            source: null,
            save: (source) => {
              if (controller.editor) insertChart(controller.editor, source);
            },
          }),
      },
    });
  }, [controller, onChange, onUnsafe, onReady, t]);

  useEffect(() => {
    controller.attach(editor);
    handleRef.current = editor
      ? { getMarkdown: () => serializeDocument(editor.getJSON(), parsedRef.current) }
      : null;
    return () => {
      controller.dispose();
      handleRef.current = null;
    };
  }, [controller, editor, handleRef]);

  useEffect(() => {
    uploadFiles.current = (files, position) => {
      const target = controller.editor;
      // Handled even with nowhere to upload to: the alternative is the browser
      // navigating away from a half-written page to show the dropped file.
      if (!imageUploadEndpoint || !target || !target.isEditable) return true;
      void (async () => {
        setUploadNotice('uploading');
        let at = position;
        for (const file of files) {
          const result = await uploadImage(imageUploadEndpoint, file);
          if (!result.ok) {
            setUploadNotice(result.error);
            return;
          }
          const image = { type: 'image', attrs: { src: result.url, alt: altFromFileName(file.name) } };
          const where = Math.min(at ?? target.state.selection.from, target.state.doc.content.size);
          target.chain().focus().insertContentAt(where, image).run();
          at = undefined;
        }
        setUploadNotice(null);
      })();
      return true;
    };
  }, [controller, imageUploadEndpoint]);

  // A paused session is read-only: what is typed into it could not be sent.
  const editable = session?.editable ?? true;
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  const ui = useMemo<EditorUi>(
    () => ({
      editMermaid: (source, save) => setDialog({ kind: 'mermaid', source, save }),
      editChart: (source, save) => setDialog({ kind: 'chart', source, save }),
      editSource: (source, save) => setDialog({ kind: 'source', source, save }),
    }),
    [],
  );

  const close = () => {
    setDialog({ kind: 'none' });
    editor?.commands.focus();
  };

  if (!editor) {
    return <p className="p-4 text-sm text-muted-foreground">{t('loadingEditor')}</p>;
  }

  return (
    <EditorUiContext.Provider value={ui}>
      <Toolbar editor={editor} actions={controller.blockActions} onLink={controller.openLink} />
      {uploadNotice === 'uploading' ? (
        <p role="status" className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
          {t('imageUploading')}
        </p>
      ) : null}
      {uploadNotice !== null && uploadNotice !== 'uploading' ? (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive">
          {t(`imageUploadError_${uploadNotice}`)}
        </p>
      ) : null}
      <EditorContent editor={editor} />
      <SlashMenu
        state={slash}
        onHover={(index) => controller.updateSlash((previous) => ({ ...previous, index }))}
        onChoose={(item) => {
          const range = controller.slash.range;
          if (range) controller.chooseBlock(editor, range, item);
        }}
      />

      <LinkDialog
        open={dialog.kind === 'link'}
        initialHref={dialog.kind === 'link' ? dialog.href : ''}
        onCancel={close}
        onSave={(href) => {
          close();
          setLink(editor, href);
        }}
      />
      <ImageDialog
        open={dialog.kind === 'image'}
        uploadEndpoint={imageUploadEndpoint}
        onCancel={close}
        onSave={({ src, alt }) => {
          close();
          editor.chain().focus().setImage({ src, alt }).run();
        }}
      />
      <MermaidDialog
        open={dialog.kind === 'mermaid'}
        mode={dialog.kind === 'mermaid' && dialog.source !== null ? 'edit' : 'insert'}
        initialSource={dialog.kind === 'mermaid' ? dialog.source : null}
        onCancel={close}
        onSave={(source) => {
          if (dialog.kind === 'mermaid') dialog.save(source);
          close();
        }}
      />
      <ChartDialog
        open={dialog.kind === 'chart'}
        mode={dialog.kind === 'chart' && dialog.source !== null ? 'edit' : 'insert'}
        initialSource={dialog.kind === 'chart' ? dialog.source : null}
        onCancel={close}
        onSave={(source) => {
          if (dialog.kind === 'chart') dialog.save(source);
          close();
        }}
      />
      <SourceDialog
        open={dialog.kind === 'source'}
        initialSource={dialog.kind === 'source' ? dialog.source : ''}
        onCancel={close}
        onSave={(source) => {
          if (dialog.kind === 'source') dialog.save(source);
          close();
        }}
      />
    </EditorUiContext.Provider>
  );
}
