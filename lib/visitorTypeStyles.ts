/**
 * Badge colour classes per `visitor_types` label.
 *
 * Shared between the admin users table and the UserProfile dropdown so the
 * same label wears the same colour in both places. Unknown labels fall back
 * to the neutral navy chip.
 *
 * The labels come from the `visitor_types` seed in `supabase/setup.sql`
 * (Trainee, Trainer, VIP, Guest, Contractor, Intern, Observer). New rows in
 * `visitor_types` simply miss the colour map and render neutral.
 */
export const VISITOR_TYPE_STYLES: Record<string, string> = {
  Trainee: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  Trainer: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  VIP: 'bg-amber-400/20 text-amber-300 border-amber-400/30',
  Guest: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  Contractor: 'bg-navy-600/20 text-navy-300 border-navy-600/30',
  Intern: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
  Observer: 'bg-navy-600/20 text-navy-300 border-navy-600/30',
};

/** Colour classes for a visitor-type label, or the neutral fallback. */
export const visitorTypeStyle = (label: string | null): string =>
  (label && VISITOR_TYPE_STYLES[label]) ||
  'bg-navy-600/20 text-navy-300 border-navy-600/30';
