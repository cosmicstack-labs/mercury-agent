import * as RadixSwitch from "@radix-ui/react-switch";
import { cx } from "~/lib/cx";

export function Switch({ checked, onCheckedChange, disabled, label, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; label?: string; id?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <RadixSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className={cx("relative h-5 w-9 shrink-0 rounded-full border border-line transition-colors data-[state=checked]:bg-accent data-[state=unchecked]:bg-ink/[0.12] disabled:opacity-50")}
      >
        <RadixSwitch.Thumb className="block h-4 w-4 translate-x-[1px] rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[17px]" />
      </RadixSwitch.Root>
      {label && <label htmlFor={id} className="text-sm text-ink">{label}</label>}
    </span>
  );
}
