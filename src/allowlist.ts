/**
 * The single-user gate. Compares GitHub's immutable numeric user ID (not the
 * username, which can be renamed and then claimed by someone else).
 * Fails closed: an unset, "0" or non-numeric ALLOWED_GITHUB_USER_ID allows nobody.
 */
export function isAllowedUser(githubId: unknown, allowed: string | undefined): boolean {
	const allowedId = Number(allowed);
	return Number.isSafeInteger(allowedId) && allowedId > 0 && githubId === allowedId;
}
