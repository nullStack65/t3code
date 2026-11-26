import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** What a wide pooled segment may print beside its chip. */
export function pooledSegmentCaption(
  account: {
    readonly email: string | undefined;
    readonly displayName: string | null;
    readonly status: "held" | "signed-out" | null;
  },
  fullName: string,
  showFullName: boolean,
  resolve: MessageResolver = m,
): string | null {
  const showName = !account.email || (!!account.displayName && showFullName);
  if (showName) return fullName;
  if (account.status === "held") return resolve(msg("Held"));
  if (account.status === "signed-out") return resolve(msg("Sign in"));
  return null;
}
