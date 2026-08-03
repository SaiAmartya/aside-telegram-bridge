/**
 * The home screen's resting state.
 *
 * The old home screen opened on a composer stacked directly on top of the
 * session list, so the first thing you saw was a wall of past work. This
 * inverts that: opening the app lands on a quiet, near-empty screen -- the
 * mark, a greeting, and the composer -- and the history lives one swipe
 * below, scrolling up from under the composer.
 *
 * Nothing here is decorative-only. The greeting is the one place the app
 * addresses the owner by name, and it is also the thing that makes an
 * otherwise empty screen feel deliberate rather than unloaded.
 */
import { AsideSymbol } from './Brand';
import { ChevronDown } from './Icons';

/**
 * The greeting, by hour.
 *
 * Split into six bands rather than the usual three because the two that
 * matter most here are the edges: someone opening this at 01:00 and
 * someone opening it at 09:00 are not having the same day, and a flat
 * "Good morning" for both is the kind of copy that reads as generated.
 *
 * Pure and exported so the bands are testable without mocking a clock.
 */
export function greetingFor(name: string | undefined, date: Date): string {
  const who = (name || '').trim();
  const hour = date.getHours();

  if (hour < 5) return who ? `Up late, ${who}?` : 'Up late?';
  if (hour < 9) return who ? `Early start, ${who}` : 'Early start';
  if (hour < 12) return who ? `Morning, ${who}` : 'Good morning';
  if (hour < 17) return who ? `Afternoon, ${who}` : 'Good afternoon';
  if (hour < 21) return who ? `Evening, ${who}` : 'Good evening';
  return who ? `Still up, ${who}?` : 'Still up?';
}

/**
 * The centred mark and greeting.
 *
 * `aria-hidden` is deliberately NOT set on the greeting: it is the screen's
 * heading and the only text a screen reader has to announce what this view
 * is.
 */
export function RestHero({ name }: { name?: string }) {
  return (
    <div className="rest-hero">
      <AsideSymbol size={38} className="rest-mark" />
      <h1 className="rest-greeting">{greetingFor(name, new Date())}</h1>
    </div>
  );
}

/**
 * The affordance that says there is something below the composer.
 *
 * Without it the history is genuinely undiscoverable -- a screen that ends
 * in a composer gives no reason to think anything is under it. It is a
 * button as well as a hint so the gesture is not the only way down.
 */
export function RestCue({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  if (!count) return null;
  return (
    <button type="button" className="rest-cue" onClick={onOpen}>
      <span className="rest-cue-label">Recents</span>
      <ChevronDown size={14} strokeWidth={2} />
    </button>
  );
}
