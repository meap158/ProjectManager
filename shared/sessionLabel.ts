/**
 * How the app names a session in text: its name with its number, `"Splash" (session 138)`,
 * never the number alone, which the owner cannot place (PM-606). Without a name, `session 138`.
 */
export function sessionLabel(session: { id: number; name?: string | null }): string {
  const name = session.name?.trim();
  return name ? `"${name}" (session ${session.id})` : `session ${session.id}`;
}
