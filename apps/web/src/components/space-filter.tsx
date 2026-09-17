import { Select } from '@/components/ui/field';

export interface SpaceFilterOption {
  key: string;
  name: string;
}

/**
 * The "which space" select of a GET filter form. An empty value means every
 * space, so the unfiltered view is the URL without the parameter.
 */
export function SpaceFilterSelect({
  id,
  label,
  allLabel,
  spaces,
  value,
}: {
  id: string;
  label: string;
  allLabel: string;
  spaces: SpaceFilterOption[];
  value: string;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Select id={id} name="space" defaultValue={value} className="w-auto min-w-40">
        <option value="">{allLabel}</option>
        {spaces.map((space) => (
          <option key={space.key} value={space.key}>
            {space.name} ({space.key})
          </option>
        ))}
      </Select>
    </>
  );
}
