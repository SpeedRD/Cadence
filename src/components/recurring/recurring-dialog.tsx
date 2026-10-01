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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CURRENCIES, formatMoney } from "@/lib/currency";
import { formatDate, fromISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { RECURRING_FREQUENCIES, RECURRING_KINDS } from "@/lib/labels";
import { paidPastOccurrences, previewPostingFrom } from "@/lib/recurring";
import { LARGE_SUBSCRIPTION_THRESHOLD } from "@/lib/subscription-room";
import { checkSubscriptionRoomAction, saveRecurringAction } from "@/server/actions/recurring";

import type { SubscriptionRoom } from "@/lib/data/subscription-room";
import type { RecurringFrequency } from "@/generated/prisma/enums";

/** How long the amount field rests before the room check runs, so typing "12000" projects once, not five times. */
const ROOM_CHECK_DEBOUNCE_MS = 400;

/** The fields the room check depends on, mirrored from the (uncontrolled) inputs as they change. */
interface RoomInputs {
  amount: string;
  currency: string;
  frequency: string;
  nextDate: string;
  accountId: string;
  /** The payments-left and second-due-day fields, as typed, for the past-date note. */
  remaining: string;
  secondAnchorDay: string;
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
  /** Only meaningful when frequency is SEMI_MONTHLY: the item's other due day each month. */
  secondAnchorDay?: number | null;
  /**
   * A new item's due day of the month when it is not the day of `nextDate` -
   * the import review pre-fills a month-end series with its next 28th or 30th
   * and the 31st here. Sent only for a new item, and the save honours it only
   * while it still explains the date (see recurringSchema).
   */
  anchorDay?: number | null;
}

export function RecurringDialog({
  categories,
  accounts,
  goals = [],
  values,
  today,
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
  /** The app's business date, for the note under a next date that is already past. */
  today: Date;
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
    remaining: values.remainingOccurrences == null ? "" : String(values.remainingOccurrences),
    secondAnchorDay: values.secondAnchorDay == null ? "" : String(values.secondAnchorDay),
  });
  const [roomInputs, setRoomInputs] = useState<RoomInputs>(initialRoomInputs);
  const [room, setRoom] = useState<SubscriptionRoom | null>(null);
  const [roomPending, setRoomPending] = useState(false);
  const roomRequest = useRef(0);
  // D46: a typed date before today counts the dates before today as already
  // paid unless the user says they are missing from the accounts.
  const [postPast, setPostPast] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKind(values.kind ?? "SUBSCRIPTION");
      setRoomInputs(initialRoomInputs());
      setRoom(null);
      setPostPast(false);
    }
  }
  const updateRoomInputs = (patch: Partial<RoomInputs>) =>
    setRoomInputs((current) => ({ ...current, ...patch }));

  const { amount, currency, frequency, nextDate } = roomInputs;
  const isSemiMonthly = frequency === "SEMI_MONTHLY";

  // A next date already in the past (D46): by default the occurrences before
  // today count as already paid, as Afford counts them - the item starts at
  // its first occurrence on or after today - and the note says which. The
  // switch below is the explicit choice to post them instead, for when they
  // are not in the ledger; the note then says how many charges saving writes.
  // Only for a date the user typed (a new item, or an edit that changed the
  // date - one left alone is an overdue backlog, not a choice) on an item that
  // will be active.
  const typedDate = fromISODate(nextDate);
  const secondDay = Number(roomInputs.secondAnchorDay);
  const remainingTyped = Number(roomInputs.remaining);
  const dateTyped = !editing || nextDate !== values.nextDate;
  const typedSchedule =
    open && dateTyped && values.active !== false && typedDate !== null && (!isSemiMonthly || Number.isInteger(secondDay))
      ? {
          nextDate: typedDate,
          frequency: frequency as RecurringFrequency,
          anchorDay: typedDate.getUTCDate(),
          secondAnchorDay: isSemiMonthly ? secondDay : null,
          remainingOccurrences: Number.isInteger(remainingTyped) && remainingTyped >= 1 ? remainingTyped : null,
        }
      : null;
  const pastPreview = typedSchedule ? previewPostingFrom(typedSchedule, today) : null;
  const pastPaid = typedSchedule && pastPreview ? paidPastOccurrences(typedSchedule, today) : null;
  // Only a subscription with an amount is checked; a contribution never is
  // (its funding is planned per account in the payday check-in's Step 3),
  // and neither is a SEMI_MONTHLY item - the room check's own occurrence
  // count (installmentDates in src/lib/afford.ts) walks a single anchor day
  // and has no second one to work with, so a twice-a-month charge would be
  // undercounted by half rather than checked correctly. The last result
  // stays on screen while a new one is in flight, so the panel does not
  // flicker between keystrokes; the account pick only changes which row is
  // marked, so it does not re-run the projection.
  const shouldCheckRoom =
    open && kind === "SUBSCRIPTION" && frequency !== "SEMI_MONTHLY" && amount.trim() !== "";
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
      {!editing && values.anchorDay ? (
        <input type="hidden" name="anchorDay" value={values.anchorDay} />
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
        <Field
          label={t.nextDue}
          htmlFor="recurring-next"
          hint={t.nextDueHint}
        >
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
            onChange={(event) => updateRoomInputs({ remaining: event.target.value })}
          />
        </Field>
      </div>

      {pastPreview && pastPaid ? (
        <div className="grid gap-1.5" data-past-date>
          <input type="hidden" name="pastOccurrences" value={postPast ? "post" : "paid"} />
          <p className="text-xs text-muted-foreground" role="status">
            {postPast
              ? t.pastDateNote(
                  pastPreview.count,
                  formatDate(pastPreview.first),
                  formatDate(pastPreview.last),
                  pastPreview.capped,
                )
              : pastPaid.allPaid
                ? t.allPaymentsPast
                : t.pastDatePaidNote(
                    pastPaid.paidCount,
                    formatDate(pastPaid.first),
                    formatDate(pastPaid.last),
                    formatDate(pastPaid.nextDate),
                    pastPaid.remainingOccurrences,
                  )}
          </p>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={postPast} onCheckedChange={setPostPast} />
            {t.postPastLabel}
          </label>
          <p className="text-xs text-muted-foreground">{t.postPastHint}</p>
        </div>
      ) : null}

      {isSemiMonthly ? (
        <Field
          label={t.secondDueDay}
          htmlFor="recurring-second-anchor"
          hint={t.secondDueDayHint}
        >
          <Input
            id="recurring-second-anchor"
            name="secondAnchorDay"
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            step={1}
            className="font-mono"
            defaultValue={values.secondAnchorDay ?? ""}
            onChange={(event) => updateRoomInputs({ secondAnchorDay: event.target.value })}
            required
          />
        </Field>
      ) : null}

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
