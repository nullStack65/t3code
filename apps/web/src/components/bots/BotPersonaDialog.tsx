import {
  THREAD_STANDING_ACCENTS,
  THREAD_STANDING_AVATAR_IDS,
  type ThreadStanding,
  type ThreadStandingAccent,
  type ThreadStandingAvatarId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { BotAvatar, BOT_ACCENT_CLASSES } from "./BotAvatar";

type Request = {
  readonly initial: ThreadStanding;
  readonly isNew: boolean;
  readonly nonce: number;
  readonly resolve: (persona: ThreadStanding | null) => void;
};
let nextNonce = 0;
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a bot persona; resolves null when the user cancels. */
export function requestBotPersona(input: {
  readonly initial: ThreadStanding;
  readonly isNew: boolean;
}): Promise<ThreadStanding | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { ...input, nonce: nextNonce++, resolve } }),
  );
}

function finish(persona: ThreadStanding | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(persona);
}

/** A starting persona for a thread becoming a bot: its title, and a look picked from its id. */
export function defaultBotPersona(thread: { readonly id: string; readonly title: string }) {
  let hash = 0;
  for (const char of thread.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    name: thread.title.trim().replace(/\s+/g, " ").slice(0, 40) || "Bot",
    role: null,
    avatarId: THREAD_STANDING_AVATAR_IDS[hash % THREAD_STANDING_AVATAR_IDS.length]!,
    accent: THREAD_STANDING_ACCENTS[(hash >>> 4) % THREAD_STANDING_ACCENTS.length]!,
  } satisfies ThreadStanding;
}

export function BotPersonaDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending persona request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <BotPersonaDialog key={request.nonce} request={request} /> : null;
}

function BotPersonaDialog(props: { readonly request: Request }) {
  const gt = useGT();
  const id = useId();
  const { initial, isNew } = props.request;
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role ?? "");
  const [avatarId, setAvatarId] = useState<ThreadStandingAvatarId>(initial.avatarId);
  const [accent, setAccent] = useState<ThreadStandingAccent>(initial.accent);
  const trimmedName = name.trim().replace(/\s+/g, " ");
  const trimmedRole = role.trim().replace(/\s+/g, " ");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedName.length === 0) return;
            finish({
              name: trimmedName,
              role: trimmedRole.length === 0 ? null : trimmedRole,
              avatarId,
              accent,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? gt("Make standing bot") : gt("Edit bot persona")}</DialogTitle>
            <DialogDescription>
              <T>
                A standing bot is a long-lived lane. It lists under Bots, apart from pinned threads.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <BotAvatar avatarId={avatarId} accent={accent} size="lg" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{trimmedName || gt("Bot")}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {trimmedRole || gt("No role line")}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>
                  <T>Name</T>
                </Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={40}
                  required
                  autoFocus
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-role`}>
                  <T>Role</T>
                </Label>
                <Input
                  id={`${id}-role`}
                  value={role}
                  maxLength={80}
                  placeholder={gt("Shown when the bot has nothing newer to say")}
                  onChange={(event) => setRole(event.currentTarget.value)}
                />
              </div>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">
                  <T>Avatar</T>
                </legend>
                <div className="grid grid-cols-5 gap-1.5">
                  {THREAD_STANDING_AVATAR_IDS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-label={`${candidate} avatar`}
                      aria-pressed={candidate === avatarId}
                      onClick={() => setAvatarId(candidate)}
                      className={cn(
                        "flex h-10 items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        candidate === avatarId
                          ? "border-primary bg-accent"
                          : "border-transparent hover:bg-accent/60",
                      )}
                    >
                      <BotAvatar avatarId={candidate} accent={accent} size="md" />
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">
                  <T>Accent</T>
                </legend>
                <div className="flex flex-wrap gap-2">
                  {THREAD_STANDING_ACCENTS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-label={`${candidate} accent`}
                      aria-pressed={candidate === accent}
                      onClick={() => setAccent(candidate)}
                      className={cn(
                        "size-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        BOT_ACCENT_CLASSES[candidate].swatch,
                        candidate === accent && "ring-2 ring-inset ring-foreground/80",
                      )}
                    />
                  ))}
                </div>
              </fieldset>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => finish(null)}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={trimmedName.length === 0}>
              {isNew ? gt("Make bot") : gt("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
