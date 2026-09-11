"use client";

import { useEffect, useRef, useState } from "react";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  GoalSelect,
  type Option,
} from "@/components/form/selects";
import { SubscriptionRoomPanel } from "@/components/recurring/subscription-room-panel";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCIES, formatMoney } from "@/lib/currency";
import { getDictionary, type Locale } from "@/lib/i18n";
import { RECURRING_FREQUENCIES, RECURRING_KINDS } from "@/lib/labels";
import { LARGE_SUBSCRIPTION_THRESHOLD } from "@/lib/subscription-room";
import { checkSubscriptionRoomAction, saveRecurringAction } from "@/server/actions/recurring";

import type { SubscriptionRoom } from "@/lib/data/subscription-room";

/** How long the amount field rests before the room check runs, so typing "12000" projects once, not five times. */
const ROOM_CHECK_DEBOUNCE_MS = 400;

/** The fields the room check depends on, mirrored from the (uncontrolled) inputs as they change. */
interface RoomInputs {
  amount: string;
  currency: string;
  frequency: string;
  nextDate: string;
  accountId: string;
}

export interface RecurringFormValues {
  id?: string;
  /** The item's updatedAt when this form was built, so a stale save is refused. */
  updatedAt?: string;
  name?: string;
  amount?: number;
  currency?: string;
  frequency?: string;
  kind?: string;
  nextDate: string;
  categoryId?: string | null;
  accountId?: string | null;
  goalId?: string | null;
  note?: string | null;
  active?: boolean;
  /** Payments still owed for a finite plan; null or undefined for an open-ended item. */
  remainingOccurrences?: number | null;
}

export function RecurringDialog({
  categories,
  accounts,
  goals = [],
  values,
  trigger,
  open: controlledOpen,
  onOpenChange,
  locale,
}: {
  categories: Option[];
  accounts: Option[];
  /** Optional only for callers that can only ever create a subscription. */
  goals?: Option[];
  values: RecurringFormValues;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const editing = Boolean(values.id);
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;
  const [kind, setKind] = useState(values.kind ?? "SUBSCRIPTION");
  const isContribution = kind === "CONTRIBUTION";

  // Same controlled/uncontrolled resolution and reset-on-open dance as
  // TransactionDialog: the Kind <Select> is uncontrolled and remounts (back to
  // its defaultValue) every time the dialog re-opens, so `kind` must be reset
  // in lockstep or a cancelled "Contribution" pick would keep the goal field
  // showing while the Select says "Subscription".
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [wasOpen, setWasOpen] = useState(open);

  // An existing item whose link is missing (or points at an account that is no
  // longer active) must show up as unset, never quietly fall back to the first
  // option - that is how the user notices it is not posting. Only a brand-new
  // item gets the first account as a convenience; a goal is always an
  // explicit choice.
  const knownAccount = accounts.some((account) => account.id === values.accountId);
  const accountDefault = knownAccount
    ? (values.accountId ?? undefined)
    : editing
      ? undefined
      : accounts[0]?.id;
  const goalDefault = goals.some((goal) => goal.id === values.goalId)
    ? (values.goalId ?? undefined)
    : undefined;

  // The large-subscription room check (see src/lib/data/subscription-room.ts).
  // The inputs stay uncontrolled - the save reads the FormData as before - and
  // are only mirrored here so the check can re-run as they change. Like `kind`,
  // the mirror resets whenever the dialog re-opens, since the inputs remount
  // to their defaults then.
  const initialRoomInputs = (): RoomInputs => ({
    amount: values.amount === undefined ? "" : String(values.amount),
    currency: values.currency ?? CURRENCIES[0],
    frequency: values.frequency ?? "MONTHLY",
    nextDate: values.nextDate,
    accountId: accountDefault ?? "",
  });
  const [roomInputs, setRoomInputs] = useState<RoomInputs>(initialRoomInputs);
  const [room, setRoom] = useState<SubscriptionRoom | null>(null);
  const [roomPending, setRoomPending] = useState(false);
  const roomRequest = useRef(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKind(values.kind ?? "SUBSCRIPTION");
      setRoomInputs(initialRoomInputs());
      setRoom(null);
    }
  }
  const updateRoomInputs = (patch: Partial<RoomInputs>) =>
    setRoomInputs((current) => ({ ...current, ...patch }));

  // Only a subscription with an amount is checked; a contribution never is
  // (its funding is planned per account in the payday check-in's Step 3).
  // The last result stays on screen while a new one is in flight, so the
  // panel does not flicker between keystrokes; the account pick only changes
  // which row is marked, so it does not re-run the projection.
  const shouldCheckRoom = open && kind === "SUBSCRIPTION" && roomInputs.amount.trim() !== "";
  const { amount, currency, frequency, nextDate } = roomInputs;
  const itemId = values.id;
  useEffect(() => {
    if (!shouldCheckRoom) return;
    const request = (roomRequest.current += 1);
    const timer = setTimeout(async () => {
      setRoomPending(true);
      let next: SubscriptionRoom | null = null;
      try {
        const result = await checkSubscriptionRoomAction({
          kind: "SUBSCRIPTION",
          amount,
          currency,
          frequency,
          nextDate,
          excludeItemId: itemId,
        });
        if (result.ok) next = result.room;
      } catch {
        // Advisory only: a failed check shows nothing rather than an error.
      }
      if (request !== roomRequest.current) return;
      setRoom(next);
      setRoomPending(false);
    }, ROOM_CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // A response to inputs that have since changed is dropped, not shown.
      roomRequest.current += 1;
    };
  }, [shouldCheckRoom, amount, currency, frequency, nextDate, itemId]);

  return (
    <FormDialog
      title={editing ? t.editItem : t.newItemTitle}
      description={t.itemDescription}
      action={saveRecurringAction}
      submitLabel={editing ? t.saveChanges : t.addItem}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.itemUpdated : t.itemAdded}
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      {values.updatedAt ? (
        <input type="hidden" name="updatedAt" value={values.updatedAt} />
      ) : null}
      {editing ? (
        // The due date as rendered, so the save can tell "re-picked the date"
        // from "left it alone" and only re-anchor the item in the first case
        // (see recurringSchema).
        <input type="hidden" name="originalNextDate" value={values.nextDate} />
      ) : null}
      <input
        type="hidden"
        name="active"
        value={values.active === false ? "false" : "true"}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.name} htmlFor="recurring-name" className="sm:col-span-2">
          <Input
            id="recurring-name"
            name="name"
            defaultValue={values.name ?? ""}
            placeholder={t.namePlaceholder}
            required
          />
        </Field>
        <Field label={t.kind} htmlFor="recurring-kind">
          <EnumSelect
            id="recurring-kind"
            name="kind"
            options={RECURRING_KINDS}
            labels={common.recurringKindLabels}
            defaultValue={values.kind ?? "SUBSCRIPTION"}
            onValueChange={setKind}
          />
        </Field>
        <Field label={t.frequency} htmlFor="recurring-frequency">
          <EnumSelect
            id="recurring-frequency"
            name="frequency"
            options={RECURRING_FREQUENCIES}
            labels={common.frequencyLabels}
            defaultValue={values.frequency ?? "MONTHLY"}
            onValueChange={(frequency) => updateRoomInputs({ frequency })}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={common.amount} htmlFor="recurring-amount">
          <Input
            id="recurring-amount"
            name="amount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            defaultValue={values.amount ?? ""}
            onChange={(event) => updateRoomInputs({ amount: event.target.value })}
            required
          />
        </Field>
        <Field label={common.currency} htmlFor="recurring-currency">
          <CurrencySelect
            id="recurring-currency"
            name="currency"
            defaultValue={values.currency}
            onValueChange={(currency) => updateRoomInputs({ currency })}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.nextDue} htmlFor="recurring-next" hint={t.nextDueHint}>
          <Input
            id="recurring-next"
            type="date"
            name="nextDate"
            defaultValue={values.nextDate}
            onChange={(event) => updateRoomInputs({ nextDate: event.target.value })}
            required
          />
        </Field>
        <Field
          label={t.paymentsLeftLabel}
          htmlFor="recurring-remaining"
          hint={t.paymentsLeftHint}
        >
          <Input
            id="recurring-remaining"
            name="remainingOccurrences"
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            step={1}
            className="font-mono"
            placeholder={t.paymentsLeftPlaceholder}
            defaultValue={values.remainingOccurrences ?? ""}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.category} htmlFor="recurring-category">
          <CategorySelect
            id="recurring-category"
            name="categoryId"
            categories={categories}
            defaultValue={values.categoryId ?? "none"}
            common={common}
          />
        </Field>
        <Field label={common.account} htmlFor="recurring-account" hint={t.accountHint}>
          <AccountSelect
            id="recurring-account"
            name="accountId"
            accounts={accounts}
            defaultValue={accountDefault}
            common={common}
            onValueChange={(accountId) => updateRoomInputs({ accountId })}
          />
        </Field>
      </div>

      {shouldCheckRoom && room?.large ? (
        <SubscriptionRoomPanel
          room={room}
          selectedAccountId={roomInputs.accountId}
          threshold={formatMoney(LARGE_SUBSCRIPTION_THRESHOLD.amount, LARGE_SUBSCRIPTION_THRESHOLD.currency, {
            maximumFractionDigits: 0,
          })}
          locale={locale}
        />
      ) : roomPending && shouldCheckRoom ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t.roomChecking}
        </p>
      ) : null}

      {isContribution ? (
        <Field
          label={t.goal}
          htmlFor="recurring-goal"
          hint={goals.length === 0 ? t.noGoalsYet : t.goalHint}
        >
          <GoalSelect
            id="recurring-goal"
            name="goalId"
            goals={goals}
            defaultValue={goalDefault}
            common={common}
          />
        </Field>
      ) : null}

      <Field label={common.note} htmlFor="recurring-note">
        <Textarea
          id="recurring-note"
          name="note"
          rows={2}
          placeholder={common.optional}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
  );
}
