"use client";

import { useCallback, useState } from "react";

import { FormDialog } from "@/components/form/form-dialog";
import { Field } from "@/components/form/field";
import {
  AccountSelect,
  CategorySelect,
  CurrencySelect,
  EnumSelect,
  type Option,
} from "@/components/form/selects";
import { ExtraordinaryPrompt } from "@/components/transactions/extraordinary-prompt";
import { PostedMatchPrompt } from "@/components/transactions/posted-match-prompt";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConversionPreview } from "@/components/form/conversion-preview";
import { CURRENCIES, formatMoney, type RateTable } from "@/lib/currency";
import type { MoneyRow } from "@/lib/account-money";
import { fromISODate, toISODate } from "@/lib/date";
import { isAdoptedDeposit, type AdoptedWindow } from "@/lib/period-income";
import { formatDayMonth } from "@/lib/date-format";
import { canBeEarmarked, defaultEarmarkAmount, stillAskedOf, type EarmarkOption } from "@/lib/earmarks";
import { getDictionary, type Locale } from "@/lib/i18n";
import { parseAmountInput, round2 } from "@/lib/money";
import { canBeOneOffIncome, canBeSharedExpense } from "@/lib/transactions";
import { saveTransactionAction } from "@/server/actions/transactions";

import type { OpenSharedExpense } from "@/lib/data/transactions";
import type { ActionState, ExtraordinarySuggestion, PostedMatchSuggestion } from "@/server/actions/utils";

export interface TransactionFormValues {
  id?: string;
  date: string;
  amount?: number;
  currency?: string;
  type?: string;
  accountId?: string;
  categoryId?: string | null;
  note?: string | null;
  transferDirection?: string | null;
  /** The user's own part of a shared expense (Transaction.yourShare), when editing one. */
  yourShare?: number | null;
  /** The shared expense an income row pays back (Transaction.reimbursesTransactionId), when editing one. */
  reimbursesTransactionId?: string | null;
  /** The user marked this income as a one-off (Transaction.isOneOffIncome), when editing one. */
  isOneOffIncome?: boolean;
  /** What this deposit is set aside for (RecurringEarmark), in its account's currency, when editing one. */
  earmarks?: { occurrenceKey: string; amount: number }[];
  /** With externalId, lets canBeSharedExpense decide whether the share switch is offered; a new row is MANUAL. */
  source?: string;
  externalId?: string | null;
  /**
   * The row being edited as stored, in its account's currency (K7), with the
   * currency of the account it is on - so the conversion preview says when
   * re-saving keeps the stored rate. `amount` and `currency` above are what
   * it was entered as.
   */
  stored?: { row: MoneyRow; accountCurrency: string };
}

/** One "This money is for an upcoming payment" line as the form holds it: the amount as typed, or the default while untouched. */
interface EarmarkLine {
  key: string;
  amount: string;
  touched: boolean;
}

function linesFrom(earmarks: TransactionFormValues["earmarks"]): EarmarkLine[] {
  return (earmarks ?? []).map((earmark) => ({ key: earmark.occurrenceKey, amount: String(earmark.amount), touched: true }));
}

export function TransactionDialog({
  accounts,
  categories,
  openSharedExpenses,
  earmarkOptions,
  adoptedWindows = [],
  values,
  rates,
  trigger,
  open: controlledOpen,
  onOpenChange,
  locale,
}: {
  accounts: Option[];
  categories: Option[];
  /** What an INCOME row can be linked to as a reimbursement - see listOpenSharedExpenses. */
  openSharedExpenses: OpenSharedExpense[];
  /** The upcoming payments a deposit can be set aside for - see listEarmarkOptions. */
  earmarkOptions: EarmarkOption[];
  /** Where a confirmed check-in adopted deposits as pay (loadAdoptedWindows): a deposit there is not offered for a payment. */
  adoptedWindows?: AdoptedWindow[];
  values: TransactionFormValues;
  /** The request's rate table, for the conversion preview (ConversionPreview). */
  rates: RateTable["rates"];
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const editing = Boolean(values.id);
  const [type, setType] = useState(values.type ?? "EXPENSE");
  const isExternalTransfer = type === "EXTERNAL_TRANSFER";

  // The account and category are tracked so that picking the expense a deposit
  // reimburses can fill them in (prefillFromExpense below). "Touched" means the
  // user changed the field themselves in this session: Radix calls
  // onValueChange for their picks only, never for a programmatic value, so the
  // prefill can never count as a touch.
  const defaultAccountId = values.accountId ?? accounts[0]?.id;
  const defaultCategoryId = values.categoryId ?? "none";
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  const [accountTouched, setAccountTouched] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const resetCategory = () => {
    setCategoryId(defaultCategoryId);
    setCategoryTouched(false);
  };
  const changeType = (next: string) => {
    setType(next);
    // The category field is unmounted for a transfer and comes back at its
    // default, so the state it mirrors goes back with it, as does the
    // direction picker.
    if (next === "EXTERNAL_TRANSFER") resetCategory();
    if (next !== "EXTERNAL_TRANSFER") setDirection(values.transferDirection ?? "OUT");
  };
  // An external transfer's direction, tracked only to tell an incoming one -
  // which can be set aside for a payment - from an outgoing one.
  const [direction, setDirection] = useState(values.transferDirection ?? "OUT");

  // The share switch, carried as a hidden field the way the goal form carries
  // isDebt (the Radix switch is not a form control of its own), and the
  // currency, tracked only to label the share input with its code. Both
  // reset with `type` below.
  const [isShared, setIsShared] = useState(values.yourShare != null);
  // A new entry's currency follows its account's until the user picks one
  // (K7: most entries are in the account's own currency); an edit keeps the
  // currency it was entered in.
  const [chosenCurrency, setChosenCurrency] = useState(values.currency ?? CURRENCIES[0]);
  const [currencyTouched, setCurrencyTouched] = useState(false);
  // "Amount charged in <account currency>", as typed: the bank's own figure
  // for an entry in another currency (chargedInAccount).
  const [chargedText, setChargedText] = useState("");
  // The amount as typed, for the conversion preview under it.
  const [amountText, setAmountText] = useState(values.amount === undefined ? "" : String(values.amount));
  // The one-off income switch, carried as a hidden field like the share
  // switch, and the reimbursement pick it depends on: a deposit linked to a
  // shared expense is already left out of income averages by its link, so the
  // switch is offered only while no expense is picked (canBeOneOffIncome).
  const [isOneOffIncome, setIsOneOffIncome] = useState(values.isOneOffIncome ?? false);
  const [reimbursesId, setReimbursesId] = useState(values.reimbursesTransactionId ?? "none");
  const canFlagOneOffIncome = canBeOneOffIncome({
    type,
    source: values.source ?? "MANUAL",
    reimbursesTransactionId: reimbursesId === "none" ? null : reimbursesId,
  });
  // Same rows the one-off flag admits: an organic expense. A new row is MANUAL
  // and always qualifies; an edit of a posted recurring charge does not.
  const canShare = canBeSharedExpense({
    type: "EXPENSE",
    source: values.source ?? "MANUAL",
    externalId: values.externalId ?? null,
  });

  // "This money is for an upcoming payment" (src/lib/earmarks.ts): a deposit
  // - income, or money coming in from outside - set aside for occurrences
  // charged to the same account, each line defaulting to the smaller of what
  // the deposit has left and what the payment still asks, in the account's
  // currency, until the user types an amount of their own.
  // A deposit a confirmed check-in adopted as pay is the plan's income
  // already, like a check-in's own paycheck, so it is not offered either
  // (isAdoptedDeposit; the server refuses it too). Judged on the date and
  // account as they stand in the form.
  const [dateText, setDateText] = useState(values.date);
  const adoptedDate = fromISODate(dateText);
  const adopted =
    adoptedDate !== null &&
    isAdoptedDeposit(
      {
        accountId: accountId ?? "",
        date: adoptedDate,
        type,
        source: values.source ?? "MANUAL",
        isOneOffIncome,
        reimbursesTransactionId: reimbursesId === "none" ? null : reimbursesId,
      },
      adoptedWindows,
    );
  const canEarmark =
    !adopted &&
    canBeEarmarked({
      type,
      source: values.source ?? "MANUAL",
      transferDirection: type === "EXTERNAL_TRANSFER" ? direction : null,
    });
  const [earmarkOn, setEarmarkOn] = useState((values.earmarks ?? []).length > 0);
  const [earmarkLines, setEarmarkLines] = useState<EarmarkLine[]>(() => linesFrom(values.earmarks));
  const accountCurrency = accounts.find((account) => account.id === accountId)?.currency;
  const currency = editing || currencyTouched ? chosenCurrency : (accountCurrency ?? chosenCurrency);
  const offersCharged = Boolean(accountCurrency) && currency !== accountCurrency;
  const accountOptions = earmarkOptions.filter(
    (option) =>
      option.accountId === accountId &&
      (stillAskedOf(option, values.id) > 0 || earmarkLines.some((line) => line.key === option.occurrenceKey)),
  );
  const optionByKey = new Map(accountOptions.map((option) => [option.occurrenceKey, option]));
  // Lines for payments on another account (the account was changed) are not
  // this deposit's to keep.
  const shownLines = earmarkLines.filter((line) => line.key === "" || optionByKey.has(line.key));
  const parsedDeposit = parseAmountInput(amountText);
  const depositInAccount =
    parsedDeposit.ok && parsedDeposit.amount > 0 && accountCurrency
      ? currency === accountCurrency
        ? parsedDeposit.amount
        : rates[currency] && rates[accountCurrency]
          ? round2((parsedDeposit.amount / rates[currency]) * rates[accountCurrency])
          : 0
      : 0;
  const lineAmounts: string[] = [];
  let depositLeft = depositInAccount;
  for (const line of shownLines) {
    const option = optionByKey.get(line.key);
    const text = line.touched
      ? line.amount
      : option
        ? String(defaultEarmarkAmount(depositLeft, stillAskedOf(option, values.id)))
        : "";
    const parsed = parseAmountInput(text);
    depositLeft = round2(depositLeft - (parsed.ok ? parsed.amount : 0));
    lineAmounts.push(text);
  }
  const firstFreeOption = (taken: readonly EarmarkLine[]) =>
    accountOptions.find((option) => !taken.some((line) => line.key === option.occurrenceKey))?.occurrenceKey ?? "";
  const turnEarmarkOn = (on: boolean) => {
    setEarmarkOn(on);
    if (on && shownLines.length === 0) setEarmarkLines([{ key: firstFreeOption([]), amount: "", touched: false }]);
  };
  const updateLine = (index: number, change: Partial<EarmarkLine>) =>
    setEarmarkLines(shownLines.map((line, at) => (at === index ? { ...line, ...change } : line)));

  // Mirrors FormDialog's own controlled/uncontrolled resolution so this
  // component can see the effective open state even for the "New
  // transaction" trigger, which never passes `open`/`onOpenChange` and so
  // is uncontrolled from here down.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  // The "New transaction" dialog is a single long-lived instance (the page
  // only mounts it once), so this component's own state does NOT reset
  // just because the dialog closes. The Type <Select> below is uncontrolled
  // and DOES get remounted (and visually reset to its defaultValue) each
  // time Radix re-opens the dialog's content. Without this, cancelling out
  // of an External transfer selection and reopening the dialog left `type`
  // stuck at EXTERNAL_TRANSFER while the Select visibly showed "Expense"
  // again - hiding the category field and silently forcing categoryId to
  // null on the next save. Reset `type` in lockstep with the same open
  // transition that resets the Select - adjusted during render (React's
  // documented pattern for this), not in an effect, to avoid an extra
  // render pass. The share switch and currency follow the same rule.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setType(values.type ?? "EXPENSE");
      setIsShared(values.yourShare != null);
      setIsOneOffIncome(values.isOneOffIncome ?? false);
      setReimbursesId(values.reimbursesTransactionId ?? "none");
      setChosenCurrency(values.currency ?? CURRENCIES[0]);
      setCurrencyTouched(false);
      setChargedText("");
      setAmountText(values.amount === undefined ? "" : String(values.amount));
      setDirection(values.transferDirection ?? "OUT");
      setEarmarkOn((values.earmarks ?? []).length > 0);
      setEarmarkLines(linesFrom(values.earmarks));
      setAccountId(defaultAccountId);
      setAccountTouched(false);
      resetCategory();
    }
  }

  // Picking the shared expense a new deposit pays back defaults the deposit to
  // that expense's account and category, each only while the user has not
  // chosen one themselves. An edit never prefills - a saved deposit's account
  // is where the money actually landed - and "none" leaves both as they are.
  // An account outside `accounts` (an archived one the new-transaction picker
  // does not offer) is skipped rather than set to a value the select cannot show.
  const prefillFromExpense = (expenseId: string) => {
    if (editing) return;
    const expense = openSharedExpenses.find((candidate) => candidate.id === expenseId);
    if (!expense) return;
    if (!accountTouched && accounts.some((account) => account.id === expense.accountId)) {
      setAccountId(expense.accountId);
    }
    if (!categoryTouched) {
      if (expense.categoryId === null) setCategoryId("none");
      else if (categories.some((category) => category.id === expense.categoryId)) {
        setCategoryId(expense.categoryId);
      }
    }
  };

  // A save that created an unusually large expense comes back with a
  // suggestion (ActionState.extraordinarySuggestion). The row is already
  // saved, so the question is asked after the form has closed and toasted,
  // in its own small dialog; only the "New transaction" instance, which the
  // page keeps mounted, ever receives one - edits are never classified.
  // A save whose row matches a posted recurring charge or a recorded
  // paycheck comes back the same way (ActionState.postedMatchSuggestion);
  // that question goes first, and the one-off question follows only if the
  // entry is kept.
  const [suggestion, setSuggestion] = useState<ExtraordinarySuggestion | null>(null);
  const [postedSuggestion, setPostedSuggestion] = useState<PostedMatchSuggestion | null>(null);
  const handleSuccess = useCallback((state: NonNullable<ActionState>) => {
    setSuggestion(state.extraordinarySuggestion ?? null);
    setPostedSuggestion(state.postedMatchSuggestion ?? null);
  }, []);
  const closeSuggestion = useCallback(() => setSuggestion(null), []);
  const closePostedSuggestion = useCallback(() => setPostedSuggestion(null), []);
  const keptPosted = useCallback(() => {
    setPostedSuggestion(null);
    setSuggestion(null);
  }, []);

  return (
    <>
    <PostedMatchPrompt
      suggestion={postedSuggestion}
      onCloseAction={closePostedSuggestion}
      onKeptAction={keptPosted}
      locale={locale}
    />
    <ExtraordinaryPrompt
      suggestion={postedSuggestion ? null : suggestion}
      onCloseAction={closeSuggestion}
      locale={locale}
    />
    <FormDialog
      title={editing ? t.editTransaction : t.newTransaction}
      description={
        editing ? undefined : t.manualDescription
      }
      action={saveTransactionAction}
      submitLabel={editing ? t.saveChanges : t.addTransaction}
      cancelLabel={common.cancel}
      savedMessage={editing ? t.transactionUpdated : t.transactionAdded}
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      onSuccess={handleSuccess}
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.type} htmlFor="transaction-type">
          <EnumSelect
            id="transaction-type"
            name="type"
            options={["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]}
            labels={common.transactionTypeLabels}
            defaultValue={values.type ?? "EXPENSE"}
            onValueChange={changeType}
          />
        </Field>
        <Field label={common.date} htmlFor="transaction-date">
          <Input
            id="transaction-date"
            type="date"
            name="date"
            defaultValue={values.date}
            onChange={(event) => setDateText(event.target.value)}
            required
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
        <Field label={common.amount} htmlFor="transaction-amount">
          <Input
            id="transaction-amount"
            name="amount"
            inputMode="decimal"
            placeholder="0.00"
            className="font-mono"
            defaultValue={values.amount ?? ""}
            onChange={(event) => setAmountText(event.target.value)}
            required
          />
        </Field>
        <Field label={common.currency} htmlFor="transaction-currency">
          <CurrencySelect
            id="transaction-currency"
            name="currency"
            value={currency}
            onValueChange={(next) => {
              setChosenCurrency(next);
              setCurrencyTouched(true);
            }}
          />
        </Field>
      </div>

      {/* In another currency than the account's, the amount is stored in the
          account's currency, converted once now (K7): what it will be saved
          as, and at which rate, before it is. */}
      {offersCharged && accountCurrency ? (
        // The bank's own figure for it, when the user has the statement: saved
        // as typed, with the amount above kept as what it was entered as.
        // Editing a row already converted offers it too, so the real figure can
        // replace the converted one without losing the original.
        <Field
          label={type === "EXPENSE" ? t.chargedAmountLabel(accountCurrency) : t.accountAmountLabel(accountCurrency)}
          htmlFor="transaction-charged"
          hint={t.chargedAmountHint}
        >
          <Input
            id="transaction-charged"
            name="chargedAmount"
            inputMode="decimal"
            className="font-mono"
            placeholder={
              values.stored && values.stored.accountCurrency === accountCurrency && values.stored.row.currency === accountCurrency
                ? String(values.stored.row.amount)
                : "0.00"
            }
            value={chargedText}
            onChange={(event) => setChargedText(event.target.value)}
          />
        </Field>
      ) : null}
      <ConversionPreview
        amount={amountText}
        currency={currency}
        accountCurrency={accountCurrency}
        rates={rates}
        previous={values.stored}
        charged={offersCharged ? chargedText : undefined}
        locale={locale}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={common.account} htmlFor="transaction-account">
          <AccountSelect
            id="transaction-account"
            name="accountId"
            accounts={accounts}
            value={accountId}
            onValueChange={(next) => {
              setAccountId(next);
              setAccountTouched(true);
            }}
            common={common}
          />
        </Field>
        {isExternalTransfer ? (
          <Field label={t.direction} htmlFor="transaction-direction">
            <EnumSelect
              id="transaction-direction"
              name="transferDirection"
              options={["OUT", "IN"]}
              labels={{ OUT: t.directionOut, IN: t.directionIn }}
              defaultValue={values.transferDirection ?? "OUT"}
              onValueChange={setDirection}
            />
          </Field>
        ) : (
          <Field label={common.category} htmlFor="transaction-category">
            <CategorySelect
              id="transaction-category"
              name="categoryId"
              categories={categories}
              value={categoryId}
              onValueChange={(next) => {
                setCategoryId(next);
                setCategoryTouched(true);
              }}
              common={common}
            />
          </Field>
        )}
      </div>

      {/* categoryId is always submitted, even when the category field is
          hidden for EXTERNAL_TRANSFER - transactionSchema forces it to null
          for that type either way, but the field must still be present in
          the FormData or validation rejects the row as missing categoryId. */}
      {isExternalTransfer ? <input type="hidden" name="categoryId" value="none" /> : null}

      {/* A shared expense (src/lib/shared-expense.ts): the amount stays what
          left the account; the share is what the averages read instead. Off
          - or absent, for a type that is not an expense - the row is an
          ordinary expense exactly as before; transactionSchema discards a
          stale share either way. */}
      {type === "EXPENSE" && !canShare && values.yourShare != null ? (
        // A share on a row the form cannot share (a posted recurring
        // charge - only a direct database edit could have put it there).
        // Shown so it is not invisible, and no switch is submitted, so
        // transactionSchema leaves it exactly as it is - an edit to the
        // note or the date never clears it (see isShared there).
        <p className="text-xs text-muted-foreground">
          {t.sharedKeptNotice(formatMoney(values.yourShare, currency))}
        </p>
      ) : null}
      {type === "EXPENSE" && canShare ? (
        <div className="grid gap-3">
          <input type="hidden" name="isShared" value={isShared ? "true" : "false"} />
          <div className="grid gap-1.5">
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={isShared} onCheckedChange={setIsShared} />
              {t.sharedExpenseLabel}
            </label>
            <p className="text-xs text-muted-foreground">{t.sharedExpenseHint}</p>
          </div>
          {isShared ? (
            <Field label={t.yourShareLabel(currency)} htmlFor="transaction-your-share">
              <Input
                id="transaction-your-share"
                name="yourShare"
                inputMode="decimal"
                placeholder="0.00"
                className="font-mono"
                defaultValue={values.yourShare ?? ""}
                required
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {/* A deposit that pays back a shared expense. Offered only while there
          is something to pay back; with nothing to offer the field is absent
          and the row is ordinary income. */}
      {type === "INCOME" && openSharedExpenses.length > 0 ? (
        <Field label={t.reimbursesLabel} htmlFor="transaction-reimburses" hint={t.reimbursesHint}>
          <Select
            name="reimbursesTransactionId"
            defaultValue={values.reimbursesTransactionId ?? "none"}
            onValueChange={(next) => {
              setReimbursesId(next);
              prefillFromExpense(next);
            }}
          >
            <SelectTrigger id="transaction-reimburses" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t.reimbursesNone}</SelectItem>
              {openSharedExpenses.map((expense) => (
                <SelectItem key={expense.id} value={expense.id}>
                  {t.reimbursesOption(
                    toISODate(expense.date),
                    expense.note ?? expense.categoryName ?? t.uncategorized,
                    formatMoney(expense.reimbursement.pending, expense.currency),
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {/* One-off income (Transaction.isOneOffIncome): a gift, a sale, a refund.
          Still this period's income everywhere; only the projection of
          future income leaves it out. Absent - no hidden field - on a row
          that cannot carry it, so transactionSchema leaves the stored flag
          alone (or clears it, for a deposit just linked to an expense). */}
      {canFlagOneOffIncome ? (
        <div className="grid gap-1.5">
          <input type="hidden" name="isOneOffIncome" value={isOneOffIncome ? "true" : "false"} />
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={isOneOffIncome} onCheckedChange={setIsOneOffIncome} />
            {t.oneOffIncomeLabel}
          </label>
          <p className="text-xs text-muted-foreground">{t.oneOffIncomeHint}</p>
        </div>
      ) : null}

      {/* Money for an upcoming payment (src/lib/earmarks.ts). Offered on a
          deposit whose account has a payment to set it aside for, or that is
          already set aside; the hidden earmarkOffered says this form showed
          it, so the switch off clears what was set aside. A row that is not a
          deposit sends nothing, and the server drops its earmarks. */}
      {canEarmark ? <input type="hidden" name="earmarkOffered" value="true" /> : null}
      {canEarmark && (accountOptions.length > 0 || shownLines.length > 0) ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={earmarkOn} onCheckedChange={turnEarmarkOn} />
              {t.earmarkLabel}
            </label>
            <p className="text-xs text-muted-foreground">{t.earmarkHint}</p>
          </div>
          {earmarkOn ? (
            <>
              {shownLines.map((line, index) => {
                const lineId = `transaction-earmark-${index}`;
                return (
                  // The payment keeps a row of its own: its label carries the
                  // date and what it still asks, too long to share one.
                  <div key={index} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <Field label={t.earmarkPaymentLabel} htmlFor={lineId} className="sm:col-span-2">
                      <Select
                        name="earmarkKey"
                        value={line.key || undefined}
                        onValueChange={(key) => updateLine(index, { key, touched: false, amount: "" })}
                      >
                        <SelectTrigger id={lineId} className="w-full">
                          <SelectValue placeholder={t.earmarkPick} />
                        </SelectTrigger>
                        <SelectContent>
                          {accountOptions
                            .filter(
                              (option) =>
                                option.occurrenceKey === line.key ||
                                !shownLines.some((other) => other.key === option.occurrenceKey),
                            )
                            .map((option) => (
                              <SelectItem key={option.occurrenceKey} value={option.occurrenceKey}>
                                {t.earmarkOption(
                                  option.name,
                                  formatDayMonth(option.dueDate, locale),
                                  formatMoney(stillAskedOf(option, values.id), option.currency),
                                )}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t.earmarkAmountLabel(accountCurrency ?? currency)} htmlFor={`${lineId}-amount`}>
                      <Input
                        id={`${lineId}-amount`}
                        name="earmarkAmount"
                        inputMode="decimal"
                        placeholder="0.00"
                        className="font-mono"
                        value={lineAmounts[index]}
                        onChange={(event) => updateLine(index, { amount: event.target.value, touched: true })}
                        required
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => {
                        const rest = shownLines.filter((_, at) => at !== index);
                        setEarmarkLines(rest);
                        if (rest.length === 0) setEarmarkOn(false);
                      }}
                    >
                      {t.earmarkRemove}
                    </Button>
                  </div>
                );
              })}
              {accountOptions.length > shownLines.length ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() =>
                    setEarmarkLines([...shownLines, { key: firstFreeOption(shownLines), amount: "", touched: false }])
                  }
                >
                  {t.earmarkAddAnother}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <Field label={common.note} htmlFor="transaction-note">
        <Textarea
          id="transaction-note"
          name="note"
          rows={2}
          placeholder={t.notePlaceholder}
          defaultValue={values.note ?? ""}
        />
      </Field>
    </FormDialog>
    </>
  );
}
