"use client";

import { EyeIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  ManagerMutation,
  ManagerSetupRequest,
  ManagerSnapshot,
  VaultCreateItemKind,
} from "@/lib/manager";
import { AddressVaultForm } from "./address-vault-form";
import { ContactVaultForm } from "./contact-vault-form";
import { LoginVaultForm } from "./login-vault-form";
import { PaymentCardForm } from "./payment-card-form";
import { useManager } from "./use-manager";

const categories = [
  {
    addLabel: "Add login",
    kind: "login",
    title: "Logins",
  },
  {
    addLabel: "Add card",
    kind: "payment",
    title: "Cards",
  },
  {
    addLabel: "Add address",
    kind: "address",
    title: "Addresses",
  },
  {
    addLabel: "Add contact",
    kind: "contact",
    title: "Contact info",
  },
] as const;

export function VaultManager({
  initialIdentifier,
  initialSetup,
}: {
  readonly initialIdentifier?: string;
  readonly initialSetup?: Extract<ManagerSetupRequest, { target: "vault" }>;
}) {
  const { busy, error, mutate, snapshot } = useManager();
  const legacyItems =
    snapshot?.vaultItems.filter(
      (item) =>
        item.kind === "identity" ||
        item.kind === "token" ||
        item.kind === "phone"
    ) ?? [];

  return (
    <main className="flex min-w-0 flex-col gap-8">
      <h1 className="sr-only">Vault</h1>

      {error ? (
        <Alert variant="destructive">
          <KeyRoundIcon />
          <AlertTitle>Vault unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {categories.map((category) => (
        <VaultCategory
          busy={busy}
          initialIdentifier={initialIdentifier}
          initialSetup={
            initialSetup?.kind === category.kind ? initialSetup : undefined
          }
          items={
            snapshot?.vaultItems.filter(
              (item) => item.kind === category.kind
            ) ?? []
          }
          key={category.kind}
          onDelete={mutate}
          onSubmit={mutate}
          {...category}
        />
      ))}

      {legacyItems.length > 0 ? (
        <section aria-labelledby="other-vault-heading" className="space-y-3">
          <h2
            className="type-caption text-muted-foreground uppercase"
            id="other-vault-heading"
          >
            Other
          </h2>
          <div className="divide-y divide-border/50 border-y border-border/50">
            {legacyItems.map((item) => (
              <VaultItemRow
                busy={busy}
                item={item}
                key={item.id}
                onDelete={mutate}
              />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function VaultCategory({
  addLabel,
  busy,
  initialIdentifier,
  initialSetup,
  items,
  kind,
  onDelete,
  onSubmit,
  title,
}: {
  readonly addLabel: string;
  readonly busy: boolean;
  readonly initialIdentifier?: string;
  readonly initialSetup?: Extract<ManagerSetupRequest, { target: "vault" }>;
  readonly items: ManagerSnapshot["vaultItems"];
  readonly kind: VaultCreateItemKind;
  readonly onDelete: (mutation: ManagerMutation) => Promise<boolean>;
  readonly onSubmit: (mutation: ManagerMutation) => Promise<boolean>;
  readonly title: string;
}) {
  const headingId = `vault-${kind}-heading`;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2
        className="type-caption text-muted-foreground uppercase"
        id={headingId}
      >
        {title}
      </h2>
      {items.length > 0 ? (
        <div className="divide-y divide-border/50 border-y border-border/50">
          {items.map((item) => (
            <VaultItemRow
              busy={busy}
              item={item}
              key={item.id}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
      <VaultDialog
        addLabel={addLabel}
        busy={busy}
        initialIdentifier={initialIdentifier}
        initialSetup={initialSetup}
        key={
          initialSetup
            ? `setup:${initialSetup.kind}:${initialSetup.label ?? ""}:${
                initialSetup.kind === "login"
                  ? `${initialSetup.identifierType}:${initialSetup.origin}:${initialIdentifier ?? ""}`
                  : ""
              }`
            : "manual"
        }
        kind={kind}
        onSubmit={onSubmit}
      />
    </section>
  );
}

function VaultItemRow({
  busy,
  item,
  onDelete,
}: {
  readonly busy: boolean;
  readonly item: ManagerSnapshot["vaultItems"][number];
  readonly onDelete: (mutation: ManagerMutation) => Promise<boolean>;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate type-label">{item.label}</p>
        {item.account ? (
          <p className="type-supporting-body truncate text-muted-foreground">
            {item.account}
          </p>
        ) : null}
      </div>
      {item.kind === "login" ? <RevealLoginButton item={item} /> : null}
      <Button
        aria-label={`Remove ${item.label}`}
        disabled={busy}
        onClick={() => void onDelete({ action: "vault.delete", id: item.id })}
        size="icon-sm"
        type="button"
        variant="quiet"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

function RevealLoginButton({
  item,
}: {
  readonly item: ManagerSnapshot["vaultItems"][number];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [secret, setSecret] = useState<{
    identifier: string;
    origin?: string;
    password: string;
  }>();

  const reveal = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/vault/reveal", {
        body: JSON.stringify({ id: item.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not reveal this password.";
        throw new Error(message);
      }
      const parsed = z
        .object({
          identifier: z.string(),
          origin: z.string().optional(),
          password: z.string(),
        })
        .parse(body);
      setSecret(parsed);
    } catch (revealError) {
      setError(
        revealError instanceof Error
          ? revealError.message
          : "Could not reveal this password."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSecret(undefined);
          setError(undefined);
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={`Show password for ${item.label}`}
            size="icon-sm"
            type="button"
            variant="quiet"
          />
        }
      >
        <EyeIcon />
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Show password</DialogTitle>
          <DialogDescription>
            This password is shown once in this dialog and is never logged.
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-2">
            <p className="type-supporting-body text-muted-foreground">
              {secret.identifier}
              {secret.origin ? ` · ${secret.origin}` : ""}
            </p>
            <Input readOnly type="text" value={secret.password} />
          </div>
        ) : (
          <div className="space-y-3">
            {error ? (
              <p className="type-supporting-body text-destructive">{error}</p>
            ) : (
              <p className="type-supporting-body text-muted-foreground">
                Confirm to decrypt the password for {item.label}.
              </p>
            )}
            <Button disabled={busy} onClick={() => void reveal()} type="button">
              Show password
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VaultDialog({
  addLabel,
  busy,
  initialIdentifier,
  initialSetup,
  kind,
  onSubmit,
}: {
  readonly addLabel: string;
  readonly busy: boolean;
  readonly initialIdentifier?: string;
  readonly initialSetup?: Extract<ManagerSetupRequest, { target: "vault" }>;
  readonly kind: VaultCreateItemKind;
  readonly onSubmit: (mutation: ManagerMutation) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(Boolean(initialSetup));
  const onSaved = () => setOpen(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            className="h-14 w-full justify-start border-dashed text-muted-foreground"
            type="button"
            variant="outline"
          />
        }
      >
        <PlusIcon />
        {addLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initialSetup?.kind === "login"
              ? `Add ${initialSetup.label}`
              : addLabel}
          </DialogTitle>
          <DialogDescription>
            {initialSetup?.kind === "login" && initialIdentifier
              ? `Type the password for ${initialIdentifier}. Everything else is already filled.`
              : kind === "login"
                ? "Enter the credentials you use to sign in."
                : "Sensitive values are encrypted before database storage and are never returned after saving."}
          </DialogDescription>
        </DialogHeader>
        {renderVaultForm({
          busy,
          initialIdentifier:
            initialSetup?.kind === "login" ? initialIdentifier : undefined,
          initialIdentifierType:
            initialSetup?.kind === "login"
              ? initialSetup.identifierType
              : undefined,
          initialLabel: initialSetup?.label,
          initialOrigin:
            initialSetup?.kind === "login" ? initialSetup.origin : undefined,
          initialPasswordHint:
            initialSetup?.kind === "login"
              ? initialSetup.passwordHint
              : undefined,
          kind,
          onSaved,
          onSubmit,
        })}
      </DialogContent>
    </Dialog>
  );
}

function renderVaultForm({
  busy,
  initialIdentifier,
  initialIdentifierType,
  initialLabel,
  initialOrigin,
  initialPasswordHint,
  kind,
  onSaved,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly initialIdentifier?: string;
  readonly initialIdentifierType?: "email" | "phone" | "username";
  readonly initialLabel?: string;
  readonly initialOrigin?: string;
  readonly initialPasswordHint?: string;
  readonly kind: VaultCreateItemKind;
  readonly onSaved: () => void;
  readonly onSubmit: (mutation: ManagerMutation) => Promise<boolean>;
}) {
  const common = { busy, initialLabel, onSaved, onSubmit };
  switch (kind) {
    case "login":
      return (
        <LoginVaultForm
          {...common}
          initialIdentifier={initialIdentifier}
          initialIdentifierType={initialIdentifierType}
          initialOrigin={initialOrigin}
          initialPasswordHint={initialPasswordHint}
        />
      );
    case "payment":
      return <PaymentCardForm {...common} />;
    case "address":
      return <AddressVaultForm {...common} />;
    case "contact":
      return <ContactVaultForm {...common} />;
  }
}
