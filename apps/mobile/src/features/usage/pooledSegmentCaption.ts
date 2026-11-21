/** What a wide pooled segment may print beside its chip. */
export function pooledSegmentCaption(
  account: {
    readonly email: string | undefined;
    readonly displayName: string | null;
    readonly status: "held" | "signed-out" | null;
  },
  fullName: string,
  showFullName: boolean,
): string | null {
  const showName = !account.email || (!!account.displayName && showFullName);
  if (showName) return fullName;
  if (account.status === "held") return "Held";
  if (account.status === "signed-out") return "Sign in";
  return null;
}
