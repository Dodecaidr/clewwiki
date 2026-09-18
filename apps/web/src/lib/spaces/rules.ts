import type { Locale } from '@/i18n/locale';

/**
 * The rules of a space: which page holds them, and what a fresh one starts as.
 *
 * The starter template lives here as a TypeScript module rather than in the
 * message catalogs because it is page content, not interface chrome: it is
 * written into a page once, edited there afterwards, and its Markdown carries
 * braces and placeholders that the ICU message formatter would try to read as
 * arguments. Both languages sit side by side so neither can be forgotten.
 *
 * Every line is a placeholder for the owner to replace. Nothing here states a
 * fact about anyone's project — an invented "we use pnpm 10" in a rules
 * document is worse than an empty heading, because an agent will believe it.
 */

export interface RulesTemplate {
  title: string;
  body: string;
}

const EN: RulesTemplate = {
  title: 'Project rules',
  body: `# Project rules

Read this before doing any work in this space. Replace every line below with
what is true for this project; delete what does not apply.

## Stack and versions

- Language and runtime: <!-- for example: TypeScript 5.9, Node.js 22 -->
- Framework: <!-- -->
- Database: <!-- -->
- Package manager and how to install: <!-- -->

## Conventions

- Commit messages: <!-- -->
- Branch names: <!-- -->
- Formatting and linting: <!-- which command decides, not which editor -->
- Tests: <!-- what has to have one, and how they are run -->

## What agents must not do

- <!-- for example: never run a migration against a live database -->
- <!-- for example: never edit files under vendor/ -->
- <!-- for example: never commit or push without being asked -->

## Where decisions live

- <!-- the space and section that holds architecture decisions -->
- <!-- who to ask when a decision is missing -->

## Review expectations

- <!-- who reviews, and what a change has to carry before review -->
- <!-- what is checked before something is called done -->
`,
};

const RU: RulesTemplate = {
  title: 'Правила проекта',
  body: `# Правила проекта

Прочитайте это перед любой работой в этом пространстве. Замените каждую строку
ниже на то, что верно для вашего проекта; лишнее удалите.

## Стек и версии

- Язык и рантайм: <!-- например: TypeScript 5.9, Node.js 22 -->
- Фреймворк: <!-- -->
- База данных: <!-- -->
- Пакетный менеджер и команда установки: <!-- -->

## Договорённости

- Сообщения коммитов: <!-- -->
- Имена веток: <!-- -->
- Форматирование и линтинг: <!-- какая команда решает, а не какой редактор -->
- Тесты: <!-- что обязано быть покрыто и как их запускать -->

## Чего агентам делать нельзя

- <!-- например: никогда не выполнять миграции на рабочей базе -->
- <!-- например: не править файлы в vendor/ -->
- <!-- например: не коммитить и не пушить без отдельной просьбы -->

## Где лежат решения

- <!-- пространство и раздел с архитектурными решениями -->
- <!-- у кого спрашивать, если решения нет -->

## Что ожидается от ревью

- <!-- кто ревьюит и что изменение должно нести с собой -->
- <!-- что проверяется, прежде чем работу считают сделанной -->
`,
};

const TEMPLATES: Record<Locale, RulesTemplate> = { en: EN, ru: RU };

/** The starter rules document in one language. */
export function rulesTemplate(locale: Locale): RulesTemplate {
  return TEMPLATES[locale];
}

/** The path segment a rules page gets when it is created from the template. */
export const RULES_PAGE_SLUG = 'rules';
