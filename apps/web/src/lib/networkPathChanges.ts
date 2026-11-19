interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

/**
 * Calls `listener` when the device moves to another kind of network, such as Wi-Fi to
 * Ethernet, where the browser reports it. Returns the unsubscribe.
 */
export function subscribeNetworkPathChanges(listener: () => void): () => void {
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
  if (connection?.type === undefined) return () => undefined;
  let previous = connection.type;
  // change also fires for same-network bandwidth and latency estimates; count only type changes.
  const onChange = () => {
    const type = connection.type;
    if (type === undefined || type === previous) return;
    previous = type;
    listener();
  };
  connection.addEventListener("change", onChange);
  return () => connection.removeEventListener("change", onChange);
}
