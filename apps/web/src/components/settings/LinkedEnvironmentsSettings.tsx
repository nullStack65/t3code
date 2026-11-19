import { useAtomValue } from "@effect/atom-react";
import {
  ANOTHER_ADDRESS,
  type KnownEnvironmentRow,
  linkRequestFailureMessage,
} from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { environmentCatalog } from "~/connection/catalog";
import { linkedEnvironmentsRefreshKey, useKnownEnvironments } from "~/state/knownEnvironments";
import { dismissLinkedEnvironment } from "~/state/linkedEnvironmentDismissals";
import {
  addingLinkedEnvironmentsAtom,
  addLinkedEnvironmentToApp,
  forgetLinkOnConnect,
  peerLinkEnvironment,
  useLinkableMachines,
} from "~/state/peerLinks";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useNowMinute } from "../../hooks/useNowMinute";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  // One list for links and this app's connections, the one agents here read too.
  const known = useKnownEnvironments(environmentId);
  // Links made outside this client bump nothing the shared list reads, so showing the panel
  // asks again. Listing probes every linked environment, too costly for a timer nobody asked for.
  // A list still loading counts as read now, so the next return to the window asks again.
  useLiveRefresh(
    () => {
      if (!known.isPending) known.refresh();
    },
    {
      key: linkedEnvironmentsRefreshKey(environmentId),
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const search = searchableSetting("linked-environments");
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={canLink ? <LinkEnvironmentAction environmentId={environmentId} /> : null}
    >
      {known.error ? (
        <SettingsRow title="Could not load linked environments" description={known.error} />
      ) : known.loading ? (
        <SettingsRow title="Loading linked environments…" role="status" />
      ) : known.rows.length === 0 ? (
        <SettingsRow
          title="No linked environments"
          description="Link another machine running T3 Code, such as a VPS, so agents here can launch and drive threads there."
        />
      ) : (
        known.rows.map((row) =>
          row.link === null ? (
            <AppOnlyEnvironmentRow
              key={row.environmentId}
              environmentId={environmentId}
              row={row}
              canLink={canLink}
            />
          ) : (
            <LinkedEnvironmentRow
              key={row.environmentId}
              environmentId={environmentId}
              link={row.link}
              row={row}
            />
          ),
        )
      )}
    </SettingsSection>
  );
}

/** A machine this app holds that agents here cannot reach yet, with why and the fix. */
function AppOnlyEnvironmentRow({
  environmentId,
  row,
  canLink,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: KnownEnvironmentRow;
  readonly canLink: boolean;
}) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText="In this app, not linked"
              dotClassName="bg-muted-foreground/30"
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{row.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Not linked{row.serverVersion === null ? "" : ` · ${row.serverVersion}`}
          </p>
          {row.issue ? <p className="text-xs text-muted-foreground">{row.issue.message}</p> : null}
          {row.issue?.action === "link" && row.action === null ? (
            <p className="text-xs text-muted-foreground/80">
              Link it from an app connected to {row.label}.
            </p>
          ) : null}
        </div>
        {canLink && row.action === "link" ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <LinkEnvironmentAction environmentId={environmentId} preselect={row.environmentId} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
  row,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
  readonly row: KnownEnvironmentRow;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const canAddToApp = useAtomValue(peerLinkEnvironment.addToApp.permissionAtom(environmentId));
  const removeFromApp = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // An add of this machine runs from any host's row or the automatic add; one at a time.
  const adding = useAtomValue(addingLinkedEnvironmentsAtom).has(link.environmentId);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents here stop working there. Revoke "T3 Code · …" in ${link.label}'s Sharing & access to end the session there too. An app added through this link stays under Authorized clients there until you revoke it.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Could not forget the link", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    // The way back out: the app's own connection stays unless the user removes it too.
    if (!row.inThisApp) return;
    const alsoRemove = await (requestConfirmDialog(
      `Also remove ${row.label} from this app? Its threads stay there; this app forgets its pairing. ${row.label} still lists this app under Authorized clients, where you can revoke it.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!alsoRemove) return;
    // Another host may still link it. Recorded first, so it is never added back on its own.
    const undoDismiss = dismissLinkedEnvironment(link.environmentId);
    const removed = await removeFromApp(link.environmentId);
    if (removed._tag === "Success") forgetLinkOnConnect(link.environmentId);
    else if (!isAtomCommandInterrupted(removed)) {
      // Still in the app, so it is not removed, and nothing should keep it from coming back.
      void undoDismiss.then((undo) => undo());
      failureToast(`Could not remove ${row.label}`, String(squashAtomCommandFailure(removed)));
    }
  };
  const add = async () => {
    if (row.appAddress === null) return;
    // Pairing clears a dismissal on success, so a later removal starts fresh.
    const added = await addLinkedEnvironmentToApp(environmentId, {
      environmentId: link.environmentId,
      label: link.label,
      onHostMachine: row.onHostMachine,
    });
    if (added._tag === "Interrupted") return;
    if (added._tag === "Failed") {
      failureToast(`Could not add ${link.label} to this app`, added.message);
      return;
    }
    toastManager.add({
      type: "success",
      title: `Added ${link.label} to this app`,
      ...(added.access === "read-only"
        ? {
            description:
              "Read-only: the link allows no more. Link it with full access to act there.",
          }
        : {}),
    });
  };
  const status =
    health.kind === "expired"
      ? "Expired. Link it again with a new pairing code."
      : health.kind === "unreachable"
        ? (health.detail ?? "Not answering right now.")
        : health.kind === "failing"
          ? health.detail
          : health.expiresInDays !== null
            ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Link it again to renew.`
            : "Reachable";
  // Expiry already shows in the status line.
  const issue = row.issue?.action === "relink" ? null : row.issue;
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {accessConfig[link.access].label} · {status}
          </p>
          {issue ? <p className="text-xs text-muted-foreground">{issue.message}</p> : null}
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        {canUnlink || (canAddToApp && row.action === "add-to-app") ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {canAddToApp && row.action === "add-to-app" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || adding}
                aria-busy={adding}
                onClick={() => void add()}
              >
                {adding ? "Adding…" : "Add to this app"}
              </Button>
            ) : null}
            {canUnlink ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy || adding}
                onClick={() => void forget()}
              >
                Forget
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkEnvironmentAction({
  environmentId,
  preselect,
}: {
  readonly environmentId: EnvironmentId;
  /** Opens on this machine, from its own row. */
  readonly preselect?: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const machines = useLinkableMachines(environmentId, open);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(preselect ?? null);
  const [address, setAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(preselect ?? null);
      setAddress("");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
    }
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast("Could not link the environment", linkRequestFailureMessage(minted.failure));
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const code = await resolvePairingCode();
    const result =
      code === null
        ? null
        : await link({
            environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              // A typed address links alone: only this app's own addresses name a machine.
              ...(machine === null || needsAddress
                ? {}
                : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
              pairingCode: code,
              access,
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Linked ${result.value.label}` });
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not link the environment", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogTrigger
        render={
          preselect === undefined ? (
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Link
            </Button>
          ) : (
            <Button size="xs" variant="outline">
              Link
            </Button>
          )
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link an environment</DialogTitle>
          <DialogDescription>
            Agents here can then launch, message and wait on threads there. It appears under
            Authorized clients in that environment's Sharing & access, where it can be revoked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={setChoice}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                Already linked. Linking again renews it with the access you pick.
              </p>
            ) : null}
            {needsAddress ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Address</span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    This app has no address for {machine.label} that another machine can reach.
                    Enter its https or Tailscale address.
                  </span>
                ) : null}
              </label>
            ) : null}
            {needsAddress && address.trim() ? <LinkAddressWarning address={address} /> : null}
            {selected === null || canMint ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Pairing code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null ? "From Sharing & access there, or t3 pair" : "Paste the code"
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    Create a link on {machine.label}: Settings → Sharing & access → Authorized
                    clients → Create link, then paste its code here.
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
