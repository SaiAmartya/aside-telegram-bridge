/**
 * The Permission popover.
 *
 * Model and Reasoning used to live here too, as anchored popovers. Both
 * moved into `ModelSheet`: reasoning is a row inside the model sheet now,
 * which is what freed the composer's action row to show a model name in
 * full. Permission stays a popover because it is a three-item choice with
 * a switch, not a list worth a sheet.
 */
import { Popover, PopoverRow, PopoverTitle } from './Popover';
import { Check, PermissionGlyph } from './Icons';

export interface PermissionPickerProps {
  anchor: HTMLElement | null;
  options: Array<{ id: string; label: string }>;
  /** The daemon's current mode; null when it could not be read. */
  current: string | null;
  /** The confirm-before-acting switch's state; null when unreadable. */
  finalConfirm: boolean | null;
  /**
   * True when the switch means the SOFT protocol rather than the daemon's
   * `runtimeConfig.finalConfirm` -- which is the case on every session
   * driven from a phone. The copy changes with it, because a switch that
   * describes itself wrongly is worse than no switch.
   */
  softConfirm?: boolean;
  onPickMode: (id: string) => void;
  onToggleConfirm: (next: boolean) => void;
  onClose: () => void;
}

/**
 * Aside's Permission popover.
 *
 * Three modes with a checkmark on the live one, then a divider and the
 * confirm-before-acting switch. The mode rows close the popover on pick
 * (they are a choice); the switch does not (it is a toggle you may want to
 * see settle).
 *
 * The switch is deliberately NOT labelled "Final confirm" any more. That
 * name belonged to the daemon's `runtimeConfig.finalConfirm`, which makes
 * the agent call `request_action_confirmation` -- a prompt only Aside on
 * the desktop can answer, so turning it on from a phone guaranteed a dead
 * session the first time the agent touched anything external. On a mobile
 * session it now drives the soft confirm protocol instead, and the label
 * says what it actually does.
 *
 * The footnote is not decoration. The setting is read when the next
 * `aside exec` is spawned, so a change binds from the next message and does
 * not reach into a turn already running. Saying so is cheaper than having
 * the owner discover it.
 */
export function PermissionPicker({
  anchor,
  options,
  current,
  finalConfirm,
  softConfirm,
  onPickMode,
  onToggleConfirm,
  onClose,
}: PermissionPickerProps) {
  return (
    <Popover anchor={anchor} onClose={onClose} width={224}>
      <PopoverTitle>Permission</PopoverTitle>
      {options.map((option) => (
        <PopoverRow
          key={option.id}
          selected={option.id === current}
          leading={<PermissionGlyph mode={option.id} />}
          trailing={option.id === current ? <Check size={14} /> : null}
          onClick={() => {
            onPickMode(option.id);
            onClose();
          }}
        >
          {option.label}
        </PopoverRow>
      ))}

      <div className="popover-sep" />

      <div className="popover-switch-row">
        <span className="popover-row-label">Confirm before acting</span>
        <button
          type="button"
          role="switch"
          aria-checked={finalConfirm === true}
          aria-label="Confirm before acting"
          className={`switch ${finalConfirm ? 'is-on' : ''}`}
          onClick={() => onToggleConfirm(!finalConfirm)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="popover-note">
        {softConfirm === false
          ? 'Applies from your next message.'
          : 'Asks here, on a card you can answer. Applies from your next message.'}
      </p>
    </Popover>
  );
}
