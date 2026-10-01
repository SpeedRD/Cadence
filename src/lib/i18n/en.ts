/** "1st", "2nd", "3rd", "11th", "21st"... */
function ordinalEn(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  const suffix = day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

/** "1 comparable pay period", "4 comparable pay periods". */
function comparablePeriodsEn(count: number): string {
  return count === 1 ? "1 comparable pay period" : `${count} comparable pay periods`;
}

/** How a projected income figure was reached, for a sentence that reads "...projected as <this>". */
function incomeBasisEn(periods: number): string {
  return periods === 0
    ? "zero, since no comparable pay period has any income yet"
    : `the average of ${comparablePeriodsEn(periods)}`;
}

/** "the 16th", or "the last day of the month" for an anchor of 31 (clamped in shorter months). */
function dayOfMonthEn(day: number): string {
  return day >= 31 ? "the last day of the month" : `the ${ordinalEn(day)}`;
}

export const en = {
  common: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    // Income earmarked for a recurring payment (src/lib/earmarks.ts).
    coveredBy: (amount: string, deposit: string) => `${amount} covered by ${deposit}`,
    depositOf: (date: string) => `the deposit of ${date}`,
    add: "Add",
    keepIt: "Keep it",
    saved: "Saved",
    deleted: "Deleted",
    done: "Done",
    name: "Name",
    date: "Date",
    amount: "Amount",
    currency: "Currency",
    category: "Category",
    note: "Note",
    type: "Type",
    account: "Account",
    optional: "Optional",
    checkFormAndRetry: "Check the form and try again",
    description: "Description",
    source: "Source",
    uncategorized: "Uncategorized",
    nothingToDelete: "Nothing to delete",
    pickAnAccount: "Pick an account",
    pickACategory: "Pick a category",
    pickAGoal: "Pick a goal",
    noCategory: "No category",
    today: "today",
    tomorrow: "tomorrow",
    yesterday: "yesterday",
    inDays: (n: number) => `in ${n} days`,
    daysAgo: (n: number) => `${n} days ago`,
    exploratoryNote: (subject: string) =>
      `This ${subject} is exploratory: nothing here is applied or saved until you take a separate, explicit action.`,
    accountTypeLabels: {
      CHECKING: "Checking",
      SAVINGS: "Savings",
      CASH: "Cash",
      OTHER: "Other",
    } as Record<string, string>,
    transactionTypeLabels: {
      EXPENSE: "Expense",
      INCOME: "Income",
      TRANSFER: "Transfer",
      OPENING_BALANCE: "Opening balance",
      EXTERNAL_TRANSFER: "External transfer",
    } as Record<string, string>,
    sourceLabels: {
      MANUAL: "Manual",
      CSV: "CSV",
      GMAIL: "Gmail",
      OUTLOOK: "Outlook",
      PAYPAL: "PayPal",
      PAYDAY_CHECKIN: "Payday check-in",
      OPENING_BALANCE: "Opening balance",
      RECURRING: "Recurring",
    } as Record<string, string>,
    frequencyLabels: {
      WEEKLY: "Weekly",
      BIWEEKLY: "Every 2 weeks",
      SEMI_MONTHLY: "Twice a month",
      MONTHLY: "Monthly",
      YEARLY: "Yearly",
    } as Record<string, string>,
    categoryKindLabels: {
      EXPENSE: "Expense",
      INCOME: "Income",
    },
    recurringKindLabels: {
      SUBSCRIPTION: "Subscription",
      CONTRIBUTION: "Contribution",
    } as Record<string, string>,
  },
  /** Column headers and cell labels for the Settings data export (one CSV per type). */
  dataExport: {
    yes: "Yes",
    no: "No",
    accountStatusLabels: {
      ACTIVE: "Active",
      ARCHIVED: "Archived",
    } as Record<string, string>,
    transferDirectionLabels: {
      OUT: "Out",
      IN: "In",
    } as Record<string, string>,
    payPeriodLabels: {
      A: "1st-15th",
      B: "16th-end of month",
    } as Record<string, string>,
    headers: {
      id: "ID",
      date: "Date",
      amount: "Amount",
      description: "Description",
      note: "Note",
      account: "Account",
      currency: "Currency",
      category: "Category",
      type: "Type",
      source: "Source",
      transferDirection: "Transfer direction",
      transferGroup: "Transfer group",
      externalId: "External ID",
      isExtraordinary: "One-off",
      isOneOffIncome: "One-off income",
      yourShare: "Your share",
      reimburses: "Reimburses",
      originalAmount: "Entered amount",
      originalCurrency: "Entered currency",
      rate: "Rate",
      createdAt: "Created at",
      updatedAt: "Updated at",
      name: "Name",
      targetAmount: "Target amount",
      targetDate: "Target date",
      savedAmount: "Saved so far",
      achievedAt: "Achieved at",
      goal: "Goal",
      recurringItem: "Recurring item",
      recurringExternalId: "Posted with transaction",
      kind: "Kind",
      frequency: "Frequency",
      nextDate: "Next date",
      anchorDay: "Due day of month",
      active: "Active",
      remainingOccurrences: "Payments left",
      fromAfford: "From Afford",
      detectedFrom: "Detected from",
      year: "Year",
      month: "Month",
      period: "Pay period",
      status: "Status",
      archivedAt: "Archived at",
      color: "Color",
      icon: "Icon",
      isSubscriptionDefault: "Subscriptions category",
      isSavingsDefault: "Savings category",
      isEssentialFixed: "Essential fixed",
    },
  },
  nav: {
    dashboard: "Dashboard",
    transactions: "Transactions",
    review: "Review",
    accounts: "Accounts",
    budgets: "Budgets",
    recurring: "Recurring",
    afford: "Afford",
    goals: "Goals",
    reports: "Reports",
    settings: "Settings",
    inbox: "Inbox",
    /** Phone tab bar only: the hub tab over Budgets, Recurring, Goals and Afford. */
    plan: "Plan",
    /** Phone tab bar only: the list tab over Accounts, Reports, Review and Settings. */
    more: "More",
    /** aria-label of the phone tab bar, which sits apart from the page's own navs. */
    tabBarLabel: "Main navigation",
    /** Read out with the link's label when it carries a count badge. */
    badgeLabel: (count: number) =>
      count === 1 ? "1 to review" : `${count} to review`,
  },
  more: {
    title: "More",
    description: "Maintain the ledger, look back, and configure Cadence.",
  },
  shell: {
    paidTwiceAMonth: (range: string) => `Paid twice a month. Budgets run ${range}.`,
    periodRangeFirstHalf: "1-15",
    periodRangeSecondHalf: "16-end",
    periodClosed: "Period closed",
    daysLeft: (n: number) => `${n} day${n === 1 ? "" : "s"} left`,
    lockCadenceAria: "Lock Cadence",
    toggleThemeAria: "Toggle light and dark mode",
    displayCurrencyLabel: "Display currency",
    languageLabel: "Language",
    staleRatesTitle: "Converted figures may be out of date",
    staleRatesSince: (datetime: string) =>
      `Exchange rates could not be refreshed, so converted amounts use the rates last fetched ${datetime}. DOP and EUR may come from a more recent Banco Popular rate.`,
    staleRatesNeverFetched:
      "Exchange rates could not be refreshed and none have been fetched yet, so every converted amount is an estimate.",
  },
  login: {
    createSubtitle:
      "Set a PIN to lock this ledger. It stays on this device's session, hashed in your own database.",
    loginSubtitle: "Enter your PIN to open the ledger.",
    newPin: "New PIN",
    pin: "PIN",
    confirm: "Confirm",
    confirmPinAria: "Confirm PIN",
    digitsHint: "4 to 6 digits",
    setPinAndContinue: "Set PIN and continue",
    unlock: "Unlock",
    pinAlreadySet: "A PIN is already set for this app",
    entriesMustMatch: "Both entries must match",
    pinDoesNotMatch: "That PIN doesn't match",
    forgotPin: "Forgot your PIN?",
    recoverSubtitle:
      "Enter the recovery secret from the server's environment (RECOVERY_SECRET) and choose a new PIN.",
    recoverySecret: "Recovery secret",
    setNewPin: "Set new PIN",
    backToUnlock: "Back to unlock",
    recoveryRejected: "That recovery secret doesn't match",
    recoveryNotConfigured:
      "PIN recovery isn't set up on this install - set RECOVERY_SECRET in the server environment first",
  },
  errorPage: {
    genericTitle: "Something went wrong",
    genericDescription:
      "That page could not be loaded. Nothing was changed - try again, and if it keeps happening the server log has the details.",
    ratesTitle: "Exchange rates couldn't be loaded",
    ratesDescription:
      "Cadence will not show a converted figure it cannot stand behind, so this page is on hold. Rates are fetched again on the next request - try again in a few minutes.",
    tryAgain: "Try again",
  },
  dashboard: {
    notPostingTitle: (count: number) =>
      count === 1
        ? "1 recurring item is not posting"
        : `${count} recurring items are not posting`,
    notPostingDescription:
      "These are still due, so nothing has been charged for them and they are missing from your committed total.",
    notPostingItem: (name: string, reason: string, date: string) =>
      `${name} - ${reason}, due ${date}`,
    notPostingReasonMissingAccount: "no account set",
    notPostingReasonMissingGoal: "no goal set",
    notPostingReasonMissingAccountAndGoal: "no account or goal set",
    notPostingReasonAccountArchived: "its account is archived",
    notPostingReasonGoalAchieved: "its goal is fully funded",
    notPostingReasonFailed: "last run failed",
    notPostingLink: "Fix on the recurring page",
    affordShortTitle: (count: number) =>
      count === 1
        ? "1 purchase from Afford no longer fits"
        : `${count} purchases from Afford no longer fit`,
    affordShortDescription:
      "Re-checked today - with your current income average, today's exchange rates, your commitments and goal estimates - the room their remaining payments were counting on has shrunk. Nothing is blocked - the check is advisory, like Afford's.",
    affordShortItem: (name: string, amount: string, period: string) =>
      `${name} - short by ${amount} in ${period}`,
    affordShortLink: "See them on the recurring page",
    goalsHeading: "Goals",
    overdueNotPosted: "overdue, not posted yet",
    wontPostNotCounted: (reason: string) => `won't post: ${reason}`,
    plusOutsideBudget: (amount: string) =>
      `plus ${amount} on subscriptions and savings, which the budget does not cover`,
    allGoals: "All goals",
    noGoalsTitle: "No goals yet",
    noGoalsDescription:
      "Track something you are saving towards and Cadence works out what each pay period needs to carry.",
    createGoal: "Create a goal",
    nextDays: (n: number) => `Next ${n} days`,
    nothingDue: "Nothing due in the next week.",
    periodPrefix: "Period",
    closed: "closed",
    daysLeftOfTotal: (remaining: number, total: number) =>
      `${remaining} of ${total} days left`,
    safeToSpendPerDay: "Safe to spend per day",
    leftForRest: "left for the rest of this period",
    overThePlan: "over the plan for this period",
    setBudgetPrompt:
      "Set a budget for this period and Cadence works out what you can spend each day: the budget minus what you have spent, over the days left.",
    setPeriodBudget: "Set this period's budget",
    recommendedBudget: (amount: string) =>
      `Recommended: ${amount} - what your payday check-in leaves for flexible categories.`,
    recommendedUnallocated: (available: string, unallocated: string) =>
      `Recommended: ${available} - what your payday check-in leaves for flexible categories. ${unallocated} of it is in no budget yet: budget it here, or it carries to the next period.`,
    recommendedShortfall: (amount: string) =>
      `Your payday check-in leaves ${amount} for flexible categories - the plan is over-committed, so there is nothing to budget yet.`,
    spent: "Spent",
    percentOfBudget: (pct: number) => `${pct}% of budget`,
    noBudget: "no budget",
    ofBudgeted: (amount: string) => `of ${amount} budgeted`,
    committed: "Committed",
    itemsDueBefore: (count: number, date: string) =>
      `${count} item${count === 1 ? "" : "s"} due before ${date}`,
    income: "Income",
    loggedThisPeriod: "received for this period",
    of: (amount: string) => `of ${amount}`,
    reached: "Reached",
    dueThisPeriod: "due this period",
    periodsTo: (n: number, date: string) => `${n} period${n === 1 ? "" : "s"} to ${date}`,
    perPayPeriod: "per pay period",
    perPayPeriodByHand: "per pay period by hand",
    savedAhead: (amount: string) => `${amount} dated after today, not in this figure`,
    fromRecurring: (amount: string) => `${amount} from recurring contributions`,
    planVersusContributed: (period: string, planned: string, contributed: string) =>
      `${period}: ${planned} planned · ${contributed} contributed`,
    contributedInPeriod: (period: string, contributed: string) => `${period}: ${contributed} contributed`,
    pace: "Average so far",
    perPeriod: "per period",
    onTrackFor: (date: string) => `on track for ${date}`,
    noContributionsYet: "No contributions yet",
    contributionSuffix: " · contribution",
  },
  monthlyPace: {
    title: "Monthly spending pace",
    projected: "Projected this month",
    average: "Your average",
    dayOfMonth: (elapsed: number, total: number) => `Day ${elapsed} of ${total}`,
    aboveAverage: (amount: string) => `${amount} above your average`,
    belowAverage: (amount: string) => `${amount} below your average`,
    onPace: "On pace with your average",
    setAside: (amount: string) =>
      `Not projected: ${amount} spent so far on one-offs and on other people's share of shared expenses.`,
    lifestyle: "Lifestyle",
    committed: "Committed",
    savings: "Savings & investing",
    totalOutflow: "Total cash outflow",
    basedOnMonths: (n: number) => `Based on the last ${n} completed month${n === 1 ? "" : "s"}`,
    insufficientHistoryTitle: "Monthly averages appear after three completed months of activity",
    insufficientHistoryDescription: (n: number) =>
      n === 0
        ? "Cadence needs a few months of activity to compare this month against."
        : `${n} completed month${n === 1 ? "" : "s"} tracked so far - keep logging to unlock the comparison.`,
  },
  transactions: {
    title: "Transactions",
    recordsSummary: (total: number, out: string, income: string) =>
      `${total} record${total === 1 ? "" : "s"} · ${out} out, ${income} in, by transaction date`,
    importCsv: "Import CSV",
    transfer: "Transfer",
    new: "New",
    addAccountFirstTitle: "Add an account first",
    needAccountDescription: "Transactions belong to an account, so start there.",
    goToAccounts: "Go to accounts",
    nothingHereTitle: "Nothing here yet",
    noTransactionsDescription: "Transactions you add or import will show up here.",
    noMatchFilters: "No transactions match these filters.",
    noMatchesTitle: "No matches",
    clearFilters: "Clear filters",
    pageOf: (page: number, count: number, size: number) =>
      `Page ${page} of ${count} · ${size} per page`,
    previous: "Previous",
    next: "Next",
    colDate: "Date",
    colDescription: "Description",
    colAccount: "Account",
    colSource: "Source",
    colAmount: "Amount",
    rowActionsAria: "Row actions",
    transferTo: (name: string) => `Transfer to ${name}`,
    transferFrom: (name: string) => `Transfer from ${name}`,
    anotherAccount: "another account",
    uncategorized: "Uncategorized",
    deleteTransferTitle: "Delete this transfer?",
    deleteTransferDescription: "Both sides of the transfer are removed together.",
    deleteTransactionTitle: "Delete this transaction?",
    deleteTransactionDescription: "This cannot be undone.",
    editTransaction: "Edit transaction",
    newTransaction: "New transaction",
    manualDescription: "Logged manually - source stays as Manual.",
    saveChanges: "Save changes",
    addTransaction: "Add transaction",
    notePlaceholder: "What was it for?",
    direction: "Direction",
    directionOut: "Outgoing - money left this account",
    directionIn: "Incoming - money arrived, to be forwarded",
    editTransfer: "Edit transfer",
    moveMoney: "Move money",
    transferDescription:
      "Between your own accounts. Transfers never count as income or spending.",
    recordTransfer: "Record transfer",
    from: "From",
    to: "To",
    searchNotes: "Search notes",
    allAccounts: "All accounts",
    allCategories: "All categories",
    allTypes: "All types",
    allSources: "All sources",
    accountPlaceholder: "Account",
    categoryPlaceholder: "Category",
    typePlaceholder: "Type",
    sourcePlaceholder: "Source",
    fromDateAria: "From date",
    toDateAria: "To date",
    toSeparator: "to",
    clear: "Clear",
    filters: "Filters",
    filtersActive: (count: number) => `Filters, ${count} active`,
    applyFilters: "Apply",
    removeFilter: (label: string) => `Remove filter: ${label}`,
    dateRangeChip: (from: string | undefined, to: string | undefined) =>
      from && to ? `${from} – ${to}` : from ? `From ${from}` : `Until ${to}`,
    backToTransactions: "Transactions",
    importCsvTitle: "Import CSV",
    importCsvDescription:
      "Map three columns, check the preview, then commit. Imported rows are tagged with the CSV source.",
    importedNeedAccount: "Imported rows need an account to land in.",
    transactionUpdated: "Transaction updated",
    transactionAdded: "Transaction added",
    transactionDeleted: "Transaction deleted",
    transferUpdated: "Transfer updated",
    transferRecorded: "Transfer recorded",
    signSigned: "Signed - negative is spending",
    signExpenses: "Every row is spending",
    signIncome: "Every row is income",
    step1: "Pick a file",
    step2: "Map the columns",
    step3: "Review and import",
    rowsRead: (name: string, count: number) =>
      `${name} · ${count} row${count === 1 ? "" : "s"} read`,
    csvHint:
      "A plain CSV export from your bank. Nothing is written until you review the preview below.",
    firstRowHeader: "First row is a header",
    dateColumn: "Date column",
    amountColumn: "Amount column",
    descriptionColumn: "Description column",
    dateFormat: "Date format",
    dateFormatHint: "How dates are written in your file",
    amountConvention: "Amount convention",
    importInto: "Import into account",
    categoryForEveryRow: "Category for every row",
    noCategory: "No category",
    column: (n: number) => `Column ${n}`,
    accountColumn: "Account column",
    accountColumnHint:
      "Optional. When set, only rows naming the account picked below are imported - for a Cadence export holding several accounts.",
    categoryColumn: "Category column",
    categoryColumnHint:
      "Optional. A row whose cell matches one of your categories by name is filed there; the others get the category picked below.",
    noColumn: "None",
    // The three per-row flags a Cadence export carries (see src/lib/data/export.ts).
    oneOffColumn: "One-off column",
    oneOffColumnHint:
      "Optional. A row whose cell says Yes is imported as a one-off, left out of typical-spending averages.",
    oneOffIncomeColumn: "One-off income column",
    oneOffIncomeColumnHint:
      "Optional. An income row whose cell says Yes is imported as one-off income, left out of the income Cadence expects in future periods.",
    yourShareColumn: "Your share column",
    yourShareColumnHint:
      "Optional. A spending row with an amount here is imported as a shared expense, with that much of it yours.",
    reimbursesColumn: "Reimburses column",
    reimbursesColumnHint:
      "Optional. An income row naming a shared expense here (date · description · amount, as Cadence exports it) is linked to that expense as a payback.",
    reimbursementsUnresolved: (n: number) =>
      `${n} payback${n === 1 ? "" : "s"} could not be matched to a shared expense and ${n === 1 ? "was" : "were"} imported as ordinary income`,
    otherAccount: "other account",
    otherAccountSuffix: (n: number) =>
      `${n} belong${n === 1 ? "s" : ""} to another account and will not be imported`,
    rowsReady: (count: number) => `${count} row${count === 1 ? "" : "s"} ready`,
    skippedSuffix: "skipped because the date or amount could not be read",
    unreadable: "unreadable",
    skipped: "skipped",
    showingFirst: (n: number, total: number) =>
      `Showing the first ${n} of ${total} rows.`,
    importCount: (n: number) => `Import ${n} transaction${n === 1 ? "" : "s"}`,
    imported: (count: number) => `Imported ${count} transaction${count === 1 ? "" : "s"}`,
    importLooksRecurring: (count: number) =>
      count === 1
        ? "1 pattern in your spending looks recurring"
        : `${count} patterns in your spending look recurring`,
    reviewOnRecurring: "Review",
    invalidDateRow: "A row has an invalid date",
    couldNotReadRows: "Could not read the parsed rows",
    accountNoLongerExists: "That account no longer exists",
    transactionNoLongerExists: "That transaction no longer exists",
    accountNoLongerActive: "That account is archived - pick an active one",
    categoryNoLongerExists: "That category no longer exists",
    transferNoLongerExists: "That transfer no longer exists",
    editFromTransferForm: "Edit this transfer from the transfer form",
    editContributionFromGoal:
      "This expense is a goal contribution - change it from the goal's page so the goal's progress stays in step",
    editOpeningBalanceFromAccounts:
      "This is an account's opening balance - change it from the Accounts page so it stays separate from income and spending",
    editPaycheckFromCheckin:
      "This is a paycheck a payday check-in recorded - change it by re-running that period's check-in so its figures stay in step",
    deletePaycheckFromCheckin:
      "This paycheck was recorded by a payday check-in - re-run that check-in with 0 income to remove it, so its figures stay in step",
    paycheckLocked: "Recorded by a payday check-in",
    openingBalance: "Opening balance",
    externalTransferOut: "External transfer out",
    externalTransferIn: "External transfer in",
    externalTransferBadge: "External",
    nothingToDelete: "Nothing to delete",
    detectedPatternsTitle: "Detected patterns",
    detectedPatternsDescription:
      "Repeated merchants found in this file. Accept a suggestion, choose your own, or leave a group uncategorized - the rows import either way.",
    patternRowCount: (n: number) => `${n} transaction${n === 1 ? "" : "s"}`,
    suggestedCategory: (name: string) => `Suggested: ${name}`,
    possibleSubscription: "Possible subscription",
    possibleTransfer: "Possible transfer",
    acceptCategory: (name: string) => `Accept ${name}`,
    chooseCategory: "Choose category",
    leaveUncategorized: "Leave uncategorized",
    leaveAsExpense: "Leave as expense",
    categorizeAsSubscriptions: "Categorize as Subscriptions",
    createRecurringItem: "Create recurring item",
    reviewGroup: "Review",
    showRows: (n: number) => `Show ${n} row${n === 1 ? "" : "s"}`,
    hideRows: "Hide rows",
    appliedCategory: (name: string) => `Categorized as ${name}`,
    appliedUncategorized: "Left uncategorized",
    appliedLeaveAsExpense: "Left as a regular expense",
    changeDecision: "Change",
    unknownMerchantsTitle: "Unknown merchants",
    reviewIndividually: "Review individually",
    selectedCount: (n: number) => `${n} selected`,
    selectAllAria: "Select all",
    selectRowAria: "Select row",
    markAsIncome: "Mark as income",
    appliedMarkedAsIncome: "Marked as income",
    recordAsExternalTransfer: "Record as external transfer",
    appliedExternalTransfer: "Recorded as external transfer",
    resolveTransfersHint: (n: number) =>
      `Resolve ${n} possible transfer${n === 1 ? "" : "s"} before importing`,
    possibleDuplicatesTitle: "Possible duplicates",
    possibleDuplicatesDescription:
      "These rows match transactions already imported from a CSV into this account - same date, amount and description. They are skipped unless you import them anyway.",
    checkingDuplicates: "Checking for rows already imported...",
    matchesExisting: (date: string) => `Already imported, dated ${date}`,
    importAnyway: "Import anyway",
    skipDuplicate: "Skip",
    appliedImportAnyway: "Will import",
    appliedSkipped: "Skipped",
    duplicatesSkippedHint: (n: number) =>
      `${n} possible duplicate${n === 1 ? "" : "s"} skipped - review them above to import any`,
    duplicatesNeedReview: (n: number) =>
      `${n} row${n === 1 ? " matches" : "s match"} transactions already imported - review the possible duplicates first`,
    importCollision: "Some of these rows were imported a moment ago - check the ledger and try again",
    // A row brought in that the ledger already holds as a row Cadence wrote
    // itself: a posted recurring charge or a check-in's paycheck (see
    // src/lib/data/posted-duplicates.ts).
    upcomingDuplicatesDescription:
      "A row may also be a payment in another currency that has not posted yet: it imports either way, and \"It's that payment\" records it as that payment so it is not charged again.",
    postedDuplicatesDescription:
      "Some rows match a charge Cadence already posted from a recurring item, or a paycheck a check-in recorded, on this account. An exact match (the item's name or category, a paycheck, or the same amount within a few days of the posted charge) is skipped as the posted charge unless you say it's a different one. A possible match (in another currency, or the same amount further away with neither the item's name nor its category) imports unless you say it's the posted charge.",
    postedMatchRecurring: (name: string, date: string, amount: string) => `Matches ${name}, posted ${date} for ${amount}`,
    postedMatchPaycheck: (date: string, amount: string) => `Matches the paycheck recorded ${date} for ${amount}`,
    postedMatchOthers: (list: string) => `Could also be: ${list}`,
    postedMatchPossible: "Possible match",
    postedMatchUpdates: (from: string, to: string) => `As the posted charge, it changes from ${from} to ${to}`,
    postedMatchStaysAsIs: "As the posted charge, it stays as it is",
    postedMatchBothAmounts: (recorded: string, deposit: string) =>
      `Paycheck recorded: ${recorded}. This deposit: ${deposit}. The paycheck stays as recorded.`,
    isPostedCharge: "It's the posted charge",
    isRecordedPaycheck: "It's the paycheck already recorded",
    isDifferentCharge: "It's a different charge",
    appliedPostedCharge: "Kept as the posted charge",
    appliedRecordedPaycheck: "Kept as the recorded paycheck",
    postedChargesKept: (n: number, updated: number) =>
      `${n} already in the ledger, not added again${updated ? ` (${updated} posted amount${updated === 1 ? "" : "s"} updated)` : ""}`,
    postedMatchChanged: "The posted charges changed since this file was checked - review the possible duplicates again",
    postedPromptTitle: "Is this the posted charge?",
    paycheckPromptTitle: "Is this the paycheck already recorded?",
    postedPromptDescription: (entered: string, posted: string) =>
      `Your entry of ${entered} is saved. The posted charge is ${posted}. "It's the posted charge" removes the entry you just saved and keeps the posted one, so the money is counted once. Closing this keeps both.`,
    paycheckPromptDescription: (entered: string, posted: string) =>
      `Your entry of ${entered} is saved. The paycheck the check-in recorded is ${posted}. "It's the paycheck already recorded" removes the entry you just saved and keeps the paycheck as recorded. Closing this keeps both.`,
    postedChargeKept: "Kept the posted charge - your entry wasn't added twice",
    postedChargeKeptUpdated: (from: string, to: string) => `Kept the posted charge, now ${to} (was ${from})`,
    paycheckKept: "Kept the paycheck already recorded - your entry wasn't added twice",
    postedMatchGone: "That posted charge no longer matches this entry - nothing changed",
    postedMatchNotApplicable: "Only an entry you added by hand, not yet paired with anything, can be taken as the posted charge",
    postedEntryAlreadyGone: "That entry was already removed - nothing else changed",
    postedEntryChanged: "That entry was changed after it was saved, so it was kept - remove it from the list if it is a duplicate",
    postedMatchCheckFailed: "Couldn't check the posted charge just now - nothing changed, your entry is kept",
    // Extraordinary (one-off) expenses - see src/lib/extraordinary.ts.
    extraordinaryBadge: "One-off",
    markExtraordinary: "Mark as one-off",
    unmarkExtraordinary: "Not a one-off",
    markedExtraordinary: "Marked as a one-off - left out of typical-spending averages",
    unmarkedExtraordinary: "Counted as normal spending again",
    extraordinaryNotApplicable: "Only an expense you logged or imported can be marked as a one-off",
    extraordinaryPromptTitle: "Was this a one-off?",
    extraordinaryPromptDescription: (amount: string, category: string, typical: string) =>
      `${amount} is well above what you usually spend on ${category} (typically around ${typical}). A one-off is still counted as spending, but left out of the averages behind payday suggestions and the monthly pace.`,
    extraordinaryYes: "Yes, it was a one-off",
    extraordinaryNo: "No, normal spending",
    possibleExtraordinaryTitle: "Unusually large",
    possibleExtraordinaryDescription:
      "These rows are well above what you usually spend in their category. They import as normal spending unless you mark them as one-offs, which keeps them out of the averages behind payday suggestions and the monthly pace.",
    checkingExtraordinary: "Checking for unusually large rows...",
    typicalForCategory: (category: string, typical: string) =>
      `${category} · typically around ${typical}`,
    keepAsNormal: "Keep as normal",
    appliedExtraordinary: "One-off",
    appliedNormal: "Normal spending",
    // One-off income (a gift, a sale, a refund) - see Transaction.isOneOffIncome.
    oneOffIncomeBadge: "One-off income",
    oneOffIncomeLabel: "One-off income",
    oneOffIncomeHint:
      "A gift, a sale, a refund. It counts as this period's income, but Cadence won't expect it again in future periods.",
    oneOffIncomeNotApplicable: "Only income you logged or imported can be marked as one-off income",
    // Shared expenses and their reimbursements - see src/lib/shared-expense.ts.
    sharedExpenseLabel: "This was a shared expense",
    sharedExpenseHint:
      "You paid for other people too, and they will pay you back. The full amount still leaves the account; only your share feeds the averages behind payday suggestions and the monthly pace, and the one-off check.",
    yourShareLabel: (code: string) => `Your share (${code})`,
    sharedBadge: "Shared",
    yourShareOf: (share: string) => `your share ${share}`,
    recoveredSoFar: (recovered: string, owed: string, pending: string) =>
      `Recovered so far: ${recovered} of ${owed} · ${pending} pending`,
    fullyReimbursed: (owed: string) => `Fully reimbursed: ${owed}`,
    reimbursesLabel: "This reimburses a shared expense",
    reimbursesNone: "No - ordinary income",
    reimbursesOption: (date: string, description: string, pending: string) =>
      `${date} · ${description} · ${pending} pending`,
    reimbursesHint:
      "A linked deposit raises the account's balance like any income, but is never averaged as income.",
    reimbursementOf: (description: string) => `Reimbursement: ${description}`,
    sharedNotApplicable: "Only an expense you logged or imported can be a shared expense",
    sharedKeptNotice: (share: string) =>
      `Shared expense - your share ${share}. A posted recurring charge cannot be shared or unshared here, so the share is kept as it is.`,
    sharedHasReimbursements:
      "Deposits are still linked to this shared expense - unlink or delete those first",
    reimbursedExpenseNotShared: "Pick a shared expense to reimburse",
    receivedAmountLabel: (code: string) => `Actual amount received (${code})`,
    receivedAmountHint:
      "Leave blank to record the same amount on both sides, converted at today's rate. Fill it in to record exactly what the bank credited.",
    // Amounts stored in the account's currency (src/lib/account-money.ts).
    savedAsCharged: (amount: string, rate: string) => `Saved in this account as ${amount}, as charged (${rate}).`,
    /** Shown when the entry's currency is not the account's: the bank's own figure, stored instead of a converted one. */
    chargedAmountLabel: (currency: string) => `Amount charged in ${currency}`,
    accountAmountLabel: (currency: string) => `Amount in ${currency}`,
    chargedAmountHint: "Optional. The figure on your statement; it is saved as typed, with the amount above kept.",
    savedAsTodaysRate: (amount: string, rate: string) => `Saved in this account as ${amount} (${rate}, today's rate).`,
    savedAsKeptRate: (amount: string, rate: string) =>
      `Saved in this account as ${amount} (${rate}, the rate it was saved at).`,
    enteredAs: (original: string, rate: string) => `entered as ${original} · ${rate}`,
    // Income earmarked for a recurring payment (src/lib/earmarks.ts).
    earmarkLabel: "This money is for an upcoming payment",
    earmarkHint:
      "Pick the payment it covers. That payment then asks this much less of your plan, and the money isn't counted as income on top.",
    earmarkPaymentLabel: "Payment",
    earmarkPick: "Pick a payment",
    earmarkOption: (name: string, date: string, stillAsked: string) => `${name} · ${date} · ${stillAsked} still asked`,
    earmarkAmountLabel: (code: string) => `Set aside for it (${code})`,
    earmarkAddAnother: "Add another payment",
    earmarkRemove: "Remove",
    earmarkNoPayments: "No upcoming payment is charged to this account.",
    earmarkIssues: {
      amount: "Enter an amount greater than 0 for each payment",
      duplicate: "Pick each payment once",
      target: "That payment is no longer open on this account - pick another",
      over_deposit: "The amounts set aside add up to more than this deposit",
      over_occurrence: "That is more than the payment still asks",
      not_depositable: "Only income or money coming in from outside can be set aside for a payment",
    },
    earmarkNotSavedWithDeposit: (reason: string) => `The deposit was saved, but not what it is set aside for: ${reason}`,
    // A charge entered before posting that may be an upcoming payment in another currency.
    postedMatchUpcoming: (name: string, date: string, amount: string) => `Matches ${name}, due ${date} for ${amount}, not posted yet`,
    upcomingMatchOutcome: "As that payment, your entry stays as it is and the payment won't be posted again.",
    upcomingPromptTitle: "Is this an upcoming payment?",
    upcomingPromptDescription: (entered: string, scheduled: string) =>
      `Your entry of ${entered} is saved. The payment it may be is ${scheduled}. "It's that payment" keeps your entry as the payment, so it isn't posted again on its due date. Closing this keeps both.`,
    isUpcomingPayment: "It's that payment",
    upcomingPaymentsKept: (count: number) =>
      `${count === 1 ? "1 row kept as its upcoming payment" : `${count} rows kept as their upcoming payments`} - not posted again`,
    appliedUpcomingPayment: "Imported as that payment",
    upcomingKept: (name: string) => `Kept as the ${name} payment - it won't be posted again`,
  },
  accounts: {
    title: "Accounts",
    acrossAccounts: (net: string, count: number) =>
      `${net} across ${count} account${count === 1 ? "" : "s"}`,
    whereMoneySits: "Where your money sits.",
    newAccount: "New account",
    noAccountsTitle: "No accounts yet",
    noAccountsDescription:
      "Add the accounts you actually use - checking, savings, cash - and everything else hangs off them.",
    addFirstAccount: "Add your first account",
    colType: "Type",
    colActivity: "Activity",
    colBalance: "Balance",
    scheduledAfterToday: (amount: string) => `${amount} dated after today, not in this balance`,
    transactionCount: (n: number) => `${n} transaction${n === 1 ? "" : "s"}`,
    actionsFor: (name: string) => `Actions for ${name}`,
    deleteAccountTitle: (name: string) => `Delete ${name}?`,
    transactionsGoWithIt: (n: number) =>
      `Its ${n} transaction${n === 1 ? "" : "s"} go with it, including both sides of any transfers.`,
    noTransactions: "This account has no transactions.",
    editAccount: "Edit account",
    newAccountTitle: "New account",
    saveChanges: "Save changes",
    addAccount: "Add account",
    namePlaceholder: "Everyday checking",
    accountsBreadcrumb: "Accounts",
    balance: "Balance",
    incomeIn: "Income in",
    spendingOut: "Spending out",
    byTransactionDate: "By transaction date",
    netTransfers: "Net transfers",
    inOut: (inAmount: string, outAmount: string) => `${inAmount} in · ${outAmount} out`,
    netExternal: "Net external",
    noActivityTitle: "No activity yet",
    noActivityDescription:
      "Transactions logged against this account show up here with a running balance.",
    addTransaction: "Add a transaction",
    colChange: "Change",
    transferTo: (name: string) => `Transfer to ${name}`,
    transferFrom: (name: string) => `Transfer from ${name}`,
    anotherAccount: "another account",
    transfer: "Transfer",
    accountUpdated: "Account updated",
    accountAdded: "Account added",
    accountDeleted: "Account deleted",
    accountArchived: "Account archived",
    accountRestored: "Account restored",
    accountNoLongerExists: "That account no longer exists",
    archiveAccount: "Archive account",
    restoreAccount: "Restore account",
    archiveAccountTitle: (name: string) => `Archive ${name}?`,
    archiveAccountDescription:
      "Its history stays intact everywhere it already appears - it just stops showing up when picking an account for something new.",
    archiveInstead: "Archive it instead - it has financial history to keep.",
    deletePermanently: "Delete permanently",
    activeTab: "Active",
    archivedTab: "Archived",
    noArchivedAccountsTitle: "No archived accounts",
    noArchivedAccountsDescription:
      "Accounts you archive keep their full history and show up here.",
    archivedBadge: "Archived",
    setOpeningBalance: "Set opening balance",
    editOpeningBalance: "Edit opening balance",
    openingBalanceUnavailable:
      "Only available before this account has other transactions.",
    openingBalanceDialogTitle: (name: string) => `Opening balance for ${name}`,
    openingBalanceDialogDescription:
      "The starting amount already in this account - not income, and it won't count toward budgets or reports.",
    openingBalanceAmountLabel: "Starting balance",
    openingBalanceDateLabel: "As of",
    openingBalanceSaved: "Opening balance saved",
    openingBalanceBlocked:
      "This account already has other transactions, so its opening balance is fixed. Use \"Correct starting balance\" from the account's menu instead.",
    correctStartingBalance: "Correct starting balance",
    correctStartingBalanceTitle: (name: string) => `Correct the starting balance of ${name}`,
    correctStartingBalanceDescription:
      "This account already has transactions, so its opening balance can't be edited. Enter what was already in the account before those transactions; it's recorded as an incoming external transfer, which raises the balance the way an opening balance does without counting as income or spending.",
    correctionAmountLabel: (code: string) => `Amount already in the account (${code})`,
    correctionAmountHint: "Added on top of the balance the ledger already shows.",
    correctionDateHint: "Usually the day before the first transaction you recorded.",
    startingBalanceCorrected: "Starting balance corrected",
    startingBalanceNote: "Starting balance correction",
  },
  budgets: {
    title: "Budgets",
    description:
      "Set per pay period. The overall budget drives safe to spend; category budgets track where it goes.",
    copyLastPeriod: "Copy last period",
    backToNow: "Back to now",
    overallBudget: "Overall budget",
    overallBudgetForPeriod: "Overall budget for this period",
    noOverallSet: (total: string) =>
      `No overall budget set. Category budgets total ${total} and are used instead.`,
    clearToRemove: "Clear the field to remove the overall budget.",
    prefilledFromCheckin: (amount: string) =>
      `${amount} is pre-filled from your payday check-in - nothing is saved until you confirm it.`,
    spentOf: (spent: string, total: string) => `${spent} spent of ${total}`,
    committed: "Committed",
    recurringStillToCome: (n: number) =>
      `${n} recurring item${n === 1 ? "" : "s"} still to come`,
    wontPostLeftOut: (n: number) =>
      `${n} more won't post and ${n === 1 ? "is" : "are"} left out`,
    safeToSpend: "Safe to spend",
    perDay: (amount: string, days: number) => `${amount} a day for ${days} day${days === 1 ? "" : "s"}`,
    forWholePeriod: "for the whole period",
    colCategory: "Category",
    colProgress: "Progress",
    colSpent: "Spent",
    colBudget: "Budget",
    noBudget: "no budget",
    uncategorized: "Uncategorized",
    categoryBudgetAria: (name: string) => `${name} budget`,
    saveAria: (label: string) => `Save ${label}`,
    budgetCleared: "Budget cleared",
    budgetSaved: "Budget saved",
    saveCollided: "Another save landed first. Try again.",
    pickPeriodFirst: "Pick a period first",
    noBudgetToCopy: "The previous period has no budget to copy",
    everyBudgetAlreadyCopied: "This period already has every budget from last period",
    copiedForward: (n: number) => `Copied ${n} budget${n === 1 ? "" : "s"} forward`,
  },
  recurring: {
    title: "Recurring",
    description:
      "Everything that leaves on a schedule, posted to your accounts automatically when it comes due. The payday check-in sets these items aside before the budget it proposes. Safe to spend is that budget minus what you have spent: upcoming items are not subtracted from it, so a budget set by hand should leave room for them.",
    newItem: "New item",
    subscriptions: "Subscriptions",
    monthlyAcrossActive: (amount: string, count: number) =>
      `${amount} a month across ${count} active item${count === 1 ? "" : "s"}`,
    noSubscriptionsTitle: "No subscriptions",
    noSubscriptionsDescription: "Add the bills that repeat so they stop surprising you mid-period.",
    recurringContributions: "Recurring contributions",
    monthlyGoingInto: (amount: string) => `${amount} a month going into something`,
    noContributionsTitle: "No recurring contributions",
    noContributionsDescription:
      "Money you put in on a schedule - an investment, a savings sweep - lives here.",
    editItem: "Edit recurring item",
    newItemTitle: "New recurring item",
    itemDescription:
      "Subscriptions are bills going out. Contributions are money you put into something. Both post automatically on their due date.",
    saveChanges: "Save changes",
    addItem: "Add item",
    namePlaceholder: "Netflix",
    kind: "Kind",
    frequency: "Frequency",
    nextDue: "Next due",
    nextDueHint: "Each due date is posted automatically when it comes. A date you type before today counts the dates before today as already paid, unless you choose to post them.",
    pastDateNote: (count: number, first: string, last: string, capped: boolean) =>
      `Saving posts ${count === 1 ? "1 charge" : `${count} charges`} dated ${count === 1 ? first : `${first} - ${last}`}${capped ? "; the rest follow on later runs" : ""}.`,
    /** D46: a typed past due date counts the dates before today as already paid (Afford's rule) unless the user chooses to post them. */
    pastDatePaidNote: (count: number, first: string, last: string, next: string, left: number | null) =>
      `${count === 1 ? `The payment dated ${first} counts` : `The ${count} payments dated ${first} - ${last} count`} as already paid and won't be posted. The first charge is ${next}${left === null ? "" : `, ${left === 1 ? "1 payment" : `${left} payments`} left`}.`,
    postPastLabel: "Post them - they're not in my accounts",
    postPastHint: "Turn this on only if these charges are missing from your accounts; otherwise they would be counted twice.",
    allPaymentsPast:
      "Every payment in this plan is dated before today, so they all count as already paid. There is nothing left to record - turn on posting them if they are missing from your accounts.",
    /** Only shown when Frequency is "Twice a month" - the day this item's *other* charge lands on each month. */
    secondDueDay: "Second due day",
    secondDueDayHint:
      "The other day of the month this charges on. A day that falls on a weekend is posted the Friday before, same as Next due.",
    goal: "Goal",
    accountHint: "Each due date is charged to this account.",
    paymentsLeftLabel: "Payments left",
    paymentsLeftHint:
      "Blank means ongoing. A number is how many charges are still owed, counting the next one; it stops on its own after.",
    paymentsLeftPlaceholder: "Unlimited",
    goalHint: "Each due date also logs a contribution to this goal.",
    noGoalsYet: "No goals yet - create one on the Goals page first.",
    needsAccount: "needs an account",
    needsGoal: "needs a goal",
    needsHint: "Not posting until this is set. Edit the item to fix it.",
    nextLabel: "next",
    paused: "paused",
    actionsFor: (name: string) => `Actions for ${name}`,
    pause: "Pause",
    resume: "Resume",
    deleteItemTitle: (name: string) => `Delete ${name}?`,
    stopsCounting: "It no longer counts as a commitment and nothing more is posted for it. Safe to spend does not change. Transactions it already posted stay.",
    itemUpdated: "Recurring item updated",
    itemAdded: "Recurring item added",
    itemDeleted: "Recurring item deleted",
    itemNoLongerExists: "That item no longer exists",
    accountNoLongerActive: "That account is no longer active",
    categoryNoLongerExists: "That category no longer exists",
    goalNoLongerExists: "That goal no longer exists",
    itemChangedElsewhere:
      "This item changed somewhere else while the form was open. Reopen it and make the change again.",
    itemPaused: "Paused",
    itemResumed: "Resumed",
    itemResumedNext: (date: string) => `Resumed. Next charge: ${date}`,
    finished: "finished",
    goalReached: "goal reached",
    goalReachedHint: "Its goal is fully funded, so this isn't posting. It resumes on its own if the goal's target is raised; pause it to stop counting it.",
    finishedResumeHint: "Finished - edit Payments left to restart",
    markPaidOff: "Mark as paid off",
    itemPaidOff: "Marked as paid off",
    finishedCannotResume: "This plan has finished. Edit it and set Payments left to start it again.",
    notAnInstallmentPlan: "Only an installment plan with payments left can be marked as paid off",
    paymentsLeft: (n: number) => (n === 1 ? "1 payment left" : `${n} payments left`),
    coveredOn: (date: string, covered: string) => `${date}: ${covered}`,
    roomHeading: "Which account can carry this?",
    roomDescription: (threshold: string, period: string, periods: number) =>
      `A subscription is checked when one charge is ${threshold} or more, or when its monthly total reaches that. The check works the way Afford checks a purchase: each account's income for ${period} is projected as ${incomeBasisEn(periods)} (same half of the month); its other recurring items due then, the period's goal funding (a confirmed check-in's, or an estimate at each goal's current pace) and its share of your essential fixed categories are subtracted; and its protected buffer is kept back. Twice-a-month items are not checked. Room means the account's typical margin covers the charge - not a guarantee for every period. Saving is never blocked by this.`,
    roomLowHistory: (periods: number) =>
      `Only ${comparablePeriodsEn(periods)} of income history ${periods === 1 ? "backs" : "back"} these figures, so treat them as rough until more pay periods have passed.`,
    roomChecking: "Checking which account has room...",
    roomChargesTogether: (count: number, charge: string) =>
      `${count} charges land in this period and are checked together (${charge}).`,
    roomColumnAccount: "Account",
    roomColumnHeadroom: "Above its buffer",
    roomBeforeAfter: "before / after",
    roomFits: "Room",
    roomShort: "Short",
    roomSelected: "selected",
    roomNoHistory: (account: string) =>
      `${account} received no income in the comparable periods, so only its buffer floor applies.`,
    roomRecommendMost: (account: string, headroom: string, count: number) =>
      `${count} accounts keep their buffer with this charge. ${account} has the most room left (${headroom}) - the best account to fund it from.`,
    roomRecommendOnly: (account: string, headroom: string) =>
      `${account} is the only account that keeps its buffer with this charge (${headroom} left).`,
    roomSelectedFits: (account: string) => `${account}, the account chosen above, has room for it.`,
    roomSelectedShort: (account: string, shortfall: string) =>
      `${account}, the account chosen above, would end ${shortfall} below its buffer - consider the account named here instead.`,
    roomNone: (period: string) =>
      `No account can sustain this on its own: each would end ${period} below its protected buffer.`,
    roomNoneSuggestion:
      "You can still save it as is. To spread the cost, create two smaller subscriptions instead, one per account - a subscription is always charged to a single account.",
    fromAfford: "From Afford",
    fromAffordDescription: (amount: string, count: number) =>
      `${amount} a month across ${count} plan${count === 1 ? "" : "s"} still paying - each re-checked against today's projections`,
    noFromAffordTitle: "No purchases from Afford",
    noFromAffordDescription:
      "A purchase you confirm on the Afford page is tracked here and re-checked against your projections as other commitments come and go.",
    openAfford: "Open Afford",
    stillOnTrack: "Still on track",
    stillOnTrackHint:
      "Re-checked today: every remaining payment still passes both of Afford's checks against current projections.",
    shortBy: (amount: string, period: string) => `Short by ${amount} in ${period}`,
    shortByAccountHint: (account: string) =>
      `Re-checked today: ${account} would end that period below its protected buffer. Advisory only - nothing is blocked.`,
    shortByFlexibleHint:
      "Re-checked today: that period's available-for-flexible figure would go into deficit. Advisory only - nothing is blocked.",
    suggestionsTitle: "Looks recurring",
    suggestionsDescription: (count: number) =>
      count === 1
        ? "1 pattern in your manual and CSV-imported spending repeats on a schedule but isn't tracked yet. Nothing is added until you say so."
        : `${count} patterns in your manual and CSV-imported spending repeat on a schedule but aren't tracked yet. Nothing is added until you say so.`,
    /** "Twice a month, around the 1st and the 16th" - anchorDays as the detector reports them (see RecurringCandidate). */
    suggestionCadence: (cadence: string, anchorDays: number[]) => {
      switch (cadence) {
        case "WEEKLY":
          return "Weekly";
        case "BIWEEKLY":
          return "Every 2 weeks";
        case "SEMI_MONTHLY":
          return `Twice a month, around ${dayOfMonthEn(anchorDays[0])} and ${dayOfMonthEn(anchorDays[1])}`;
        case "YEARLY":
          return `Yearly, around ${dayOfMonthEn(anchorDays[0])}`;
        case "MONTHLY":
        default:
          return `Monthly, around ${dayOfMonthEn(anchorDays[0])}`;
      }
    },
    suggestionEvidence: (count: number, first: string, last: string) =>
      `${count} charges, ${first} to ${last}`,
    addAsRecurring: "Add as recurring",
    dismissSuggestion: "Dismiss",
    dismissSuggestionHint: "Never suggest this again",
    showCharges: (count: number) => `Show ${count} charges`,
    hideCharges: "Hide charges",
    suggestionAdded: (name: string) => `${name} added to your subscriptions`,
    suggestionDismissed: "Dismissed. It won't be suggested again.",
    suggestionGone: "That suggestion is no longer there. Reload the page to see what's current.",
  },
  afford: {
    title: "Afford",
    description: "Check whether a purchase paid in installments fits the pay periods it lands in.",
    exploratorySubject: "purchase",
    purchaseHeading: "The purchase",
    purchaseName: "What are you buying?",
    purchaseNamePlaceholder: "New laptop",
    totalAmount: "Total price",
    installments: "Installments",
    installmentsHint: "How many payments the price is split into.",
    frequency: "Paid every",
    firstPayment: "First payment",
    firstPaymentHint: "Later payments follow from this date at the chosen frequency.",
    account: "Paid from",
    accountHint: "Each installment is charged to this account.",
    scheduleHeading: "Payment schedule",
    scheduleDescription:
      "Equal parts, rounded to the cent. Each one is checked against the pay period it lands in, and posts for exactly this amount.",
    paymentLabel: (n: number) => `Payment ${n}`,
    scheduleTotal: "Installments total",
    scheduleRoundedUnder: (difference: string) =>
      `Rounded to the cent: ${difference} less than the price entered.`,
    scheduleRoundedOver: (difference: string) =>
      `Rounded to the cent: ${difference} more than the price entered.`,
    noScheduleYet: "Enter a price and a number of installments to see the schedule.",
    checkAffordability: "Check affordability",
    checking: "Checking...",
    resultsStale: "The purchase changed since this verdict - check again before recording it.",
    verdictViable: "Viable",
    verdictNotViable: "Not viable",
    viableSummary: (count: number) =>
      count === 1
        ? "The pay period this lands in keeps its protected buffer and stays out of deficit with this purchase in it."
        : `All ${count} pay periods this lands in keep their protected buffer and stay out of deficit with this purchase in it.`,
    notViableSummary: (count: number) =>
      count === 1
        ? "1 pay period would fall short with this purchase in it."
        : `${count} pay periods would fall short with this purchase in it.`,
    columnPayment: "Payment",
    columnDate: "Date",
    columnPeriod: "Pay period",
    columnAmount: "Amount",
    columnAccountCheck: (account: string) => `${account} above its buffer`,
    columnFlexibleCheck: "Available for flexible categories",
    columnBeforeAfter: "before / after",
    columnVerdict: "Verdict",
    passes: "Fits",
    fails: "Short",
    checkedTogether: (count: number) =>
      `${count} payments land in this period and are checked together.`,
    shortfallHeading: "Where it falls short",
    accountShortfall: (period: string, account: string, amount: string) =>
      `${period}: ${account} would end ${amount} below its protected buffer.`,
    flexibleShortfall: (period: string, amount: string) =>
      `${period}: the period would be ${amount} short for its flexible categories.`,
    projectionHeading: "How these figures are projected",
    projectionDescription: (
      account: string,
      periods: number | null,
      coverage: "all" | "none" | "some" = "none",
      confirmedPeriods: string[] = [],
    ) =>
      `${coverage === "none" ? "No payday check-in exists for these periods yet. " : coverage === "some" ? `A payday check-in is confirmed for ${confirmedPeriods.join(", ")}, but not for the other periods. ` : ""}${coverage === "none" ? "" : `For ${confirmedPeriods.join(", ")} the figures are what the check-in confirmed - the paycheck you recorded, the buffer it kept, its carryover, essentials and goal funding - so the room is the same "Available for flexible categories" the check-in shows. `}${coverage === "all" ? "Elsewhere, income is projected as" : "Income is projected as"} ${periods === null ? "the average of the comparable pay periods noted under each period" : incomeBasisEn(periods)} (same half of the month), counted in every account from the first period with income in any of them, so pay that moved from one account to another is not counted in both. If your income changed - a new job, for example - Settings' "Count income history from" sets where that history starts. ${account}'s commitments are exact: every active recurring item charged to it that falls due in the period, walked forward from its own schedule - including any installment plan already recorded here, and, in the current period, what already posted as well as what is still ahead - plus whatever a confirmed payday check-in planned toward your goals for that period.${coverage === "all" ? "" : " Where no check-in is confirmed yet, an estimate stands in for that goal funding: what you would keep putting toward each goal at its current pace, marked * and spelled out below."} The buffer is the same formula the payday check-in applies per account, and the period-wide figures add every active account up.`,
    projectionIncomePeriods: (periods: number) => (periods === 1 ? "income: 1 period" : `income: ${periods} periods`),
    projectionConfirmed: "confirmed check-in",
    confirmedCarryoverLine: (period: string, amount: string) =>
      `${period} also counts ${amount} of carryover, as its check-in does.`,
    confirmedCapLine: (period: string, amount: string) =>
      `${period} takes ${amount} off for accounts that were below zero before the pay, as its check-in does.`,
    lowIncomeHistory: (periods: number) =>
      `Only ${comparablePeriodsEn(periods)} of income history ${periods === 1 ? "backs" : "back"} this projection, so treat its income as rough until more pay periods have passed.`,
    projectionEssential: "Essential fixed",
    noEssentialFixed: "No essential fixed budgets are set, so none are assumed in either check.",
    essentialFixedLine: (periods: string[]) =>
      `Essential fixed categories are subtracted in both checks, as the payday check-in subtracts them: ${periods.join("; ")}. Each account carries the share of it that its projected income is of the period's.`,
    essentialFixedPeriod: (period: string, amount: string, basis: "budget" | "suggestion" | "none") =>
      basis === "budget"
        ? `${period} ${amount}, the budgets already set for it`
        : basis === "suggestion"
          ? `${period} ${amount}, what the check-in would suggest from your last budgets or average spending`
          : `${period} none assumed, since nothing has been budgeted or spent in them yet`,
    projectionAccountColumns: (account: string) => `${account} (projected)`,
    projectionPeriodColumns: "All accounts (projected)",
    projectionIncome: "Income",
    projectionCommitted: "Commitments",
    projectionBuffer: "Buffer",
    noHistoryForAccount: (account: string, periods: number) =>
      periods === 0
        ? `No comparable pay period falls after your "Count income history from" date yet, so ${account}'s projected income is zero and only the buffer floor applies.`
        : `${account} received no income in the last ${comparablePeriodsEn(periods)}, so its projected income is zero and only the buffer floor applies.`,
    estimatedInCommitments: "includes an estimated goal contribution *",
    estimatedGoalItem: (amount: string, goal: string) => `${amount} toward ${goal}`,
    estimatedGoalFunding: (period: string, goals: string[]) =>
      `* ${period}: commitments include an estimated ${goals.length > 1 ? `${goals.slice(0, -1).join(", ")} and ${goals[goals.length - 1]}, each at its current pace` : `${goals[0]} at its current pace`} - not yet confirmed by a payday check-in, so it may change when you do that period's check-in.`,
    recordHeading: "Record it",
    recordedNote: (amount: string, frequency: string, count: number, date: string, paid: number) =>
      `Records one subscription of ${amount} ${frequency}, ${count} times starting ${date}.${paid > 0 ? ` The ${paid === 1 ? "payment" : `${paid} payments`} dated before today ${paid === 1 ? "counts" : "count"} as already paid and ${paid === 1 ? "is" : "are"} not recorded or posted.` : ""} It stops on its own after the last payment and shows up everywhere a subscription does - Recurring, the payday check-in, posting, reports.`,
    acknowledgeLabel:
      "I understand this purchase leaves at least one pay period below its protected buffer or in deficit, and I'm recording it anyway.",
    bought: "I bought this",
    addLater: "I'll add it myself later",
    boughtToast: "Purchase recorded as a subscription",
    recordedTitle: (name: string) => `${name} is now a recurring subscription`,
    recordedDescription: "It posts on each payment date and switches itself off after the last one.",
    viewRecurring: "See it on the Recurring page",
    noAccountsTitle: "No active accounts",
    noAccountsDescription:
      "Add an account before checking a purchase - every installment is charged to one.",
    accountNoLongerActive: "That account is no longer active",
    acknowledgeFirst: "Acknowledge the shortfall before recording the purchase",
    alreadyPaid: "Already paid",
    allInstallmentsPaid:
      "Every payment in this plan is dated before today, so they all count as already paid. There is nothing left to check or record.",
    frequencyAdverb: {
      WEEKLY: "every week",
      BIWEEKLY: "every 2 weeks",
      MONTHLY: "every month",
      YEARLY: "every year",
    } as Record<string, string>,
  },
  goals: {
    title: "Goals",
    description: "What you are saving towards, and what each pay period has to carry.",
    newGoal: "New goal",
    noGoalsTitle: "No goals yet",
    noGoalsDescription: "Add a target amount, optionally a date, and log contributions as you make them.",
    createFirstGoal: "Create your first goal",
    reached: "Reached",
    targetDate: (date: string) => `Target ${date}`,
    noTargetDate: "No target date",
    percentOf: (pct: number, amount: string) => `${pct}% of ${amount}`,
    /** Contributions dated after today: not in "saved" until their day (D42). */
    savedAhead: (amount: string) => `${amount} dated after today, not in this figure`,
    fullyFunded: "Fully funded",
    perPayPeriod: "per pay period",
    perPayPeriodByHand: "per pay period by hand",
    fromRecurring: (amount: string) => `${amount} from recurring contributions`,
    dueThisPeriod: "due this period",
    periodsLeft: (n: number) => `${n} period${n === 1 ? "" : "s"} left`,
    pace: "Average so far",
    perPeriod: "per period",
    onTrackApprox: (date: string) => `on track for ~${date}`,
    toGo: (amount: string) => `${amount} to go`,
    goalsBreadcrumb: "Goals",
    logContribution: "Log contribution",
    noTargetPaceNote: "No target date - the finish is projected from your average so far",
    stillToGo: "Still to go",
    contributionCount: (n: number) => `${n} contribution${n === 1 ? "" : "s"}`,
    perPayPeriodLabel: "Per pay period",
    perPayPeriodByHandLabel: "Per pay period, by hand",
    periodsToTarget: (n: number) => `${n} period${n === 1 ? "" : "s"} to the target date`,
    doneAround: (date: string) => `at this average, done around ${date}`,
    logToSetPace: "log a contribution to see an average",
    inCurrency: (code: string) => `In ${code}`,
    ofAmount: (amount: string) => `of ${amount}`,
    driftedWarning: (amount: string) =>
      `Cached progress does not match the contribution history (${amount}). Recalculate from Settings.`,
    contributionHistory: "Contribution history",
    noContributionsYetTitle: "No contributions yet",
    noContributionsYetDescription: "Every amount you log here is the source of truth for this goal's progress.",
    removeContributionAria: "Remove contribution",
    editGoal: "Edit goal",
    goalDialogDescription: "A target date turns the goal into a per-pay-period number.",
    saveChanges: "Save changes",
    createGoal: "Create goal",
    namePlaceholder: "Emergency fund",
    targetAmount: "Target amount",
    targetDateLabel: "Target date",
    targetDateHint: "Optional. Without one, Cadence projects from your average so far.",
    actionsFor: (name: string) => `Actions for ${name}`,
    deleteGoalTitle: (name: string) => `Delete ${name}?`,
    goalAndHistoryRemoved:
      "The goal and its contribution history are removed. The expenses those contributions wrote stay in the ledger as ordinary transactions you can edit or delete.",
    historyGoesWithIt:
      "Its contribution history goes with it. The expenses those contributions wrote stay in the ledger as ordinary transactions you can edit or delete.",
    removeContributionTitle: "Remove this contribution?",
    comesOffProgress: (amount: string) => `${amount} comes back off the goal's progress.`,
    addTo: (name: string) => `Add to ${name}`,
    contributionDialogDescription: "Contributions are the source of truth for goal progress.",
    amountWithCurrency: (code: string) => `Amount (${code})`,
    contributionAccountHint: "The money leaves this account as an expense, converted to its currency if it differs.",
    goalUpdated: "Goal updated",
    goalCreated: "Goal created",
    goalDeleted: "Goal deleted",
    goalNoLongerExists: "That goal no longer exists",
    contributionLogged: "Contribution logged",
    planVersusContributed: (period: string, planned: string, contributed: string) =>
      `${period}: ${planned} planned · ${contributed} contributed`,
    contributedInPeriod: (period: string, contributed: string) => `${period}: ${contributed} contributed`,
    plannedBehindRoadmap: (amount: string) => `${amount} behind the roadmap`,
    plannedBehindRemaining: (amount: string) => `${amount} of the remaining balance not planned`,
    notYetContributed: (amount: string, period: string) => `${amount} planned for ${period} not yet contributed`,
    roomShortfallThisPeriod: (amount: string, period: string) =>
      `${amount} of the roadmap amount for ${period} couldn't be covered by what the accounts had to spare after their subscriptions and buffer when the plan was confirmed.`,
    roomShortfallRemainingThisPeriod: (amount: string, period: string) =>
      `${amount} of the remaining balance couldn't be covered in ${period} by what the accounts had to spare after their subscriptions and buffer when the plan was confirmed.`,
    contributionRemoved: "Contribution removed",
    contributionNoLongerExists: "That contribution no longer exists",
    editContributionAria: "Edit contribution",
    editContributionTitle: "Correct this contribution",
    editContributionDescription:
      "Posted automatically by a recurring item. Changing the amount here also updates the expense it wrote in the ledger. The item's own amount for future dates is unchanged.",
    contributionUpdated: "Contribution updated",
    contributionNotRecurring: "Only a contribution posted by a recurring item is corrected here - remove a manual one and log it again",
    editManualContributionDescription:
      "Changing the account moves the expense it wrote in the ledger and converts the amount to that account's currency.",
    contributionNotManual: "Only a contribution logged by hand is corrected here",
    isDebtLabel: "This goal is a debt",
    isDebtHint: "Marks it for the debt payoff comparison on the Goals page. Nothing else about the goal changes.",
    debtBadge: "Debt",
    debtComparatorTitle: "Paying off the debts: two orders",
    debtComparatorSubject: "debt payoff comparison",
    debtComparatorDescription:
      "Each debt keeps receiving its own pace: what its roadmap asks of every pay period, recurring contributions included, less what already went in this period. Whatever extra you add goes entirely to the next debt in each order, and once a debt is paid off its pace joins the extra from the following period on.",
    extraPerPeriodLabel: (code: string) => `Extra per pay period (${code})`,
    debtFlowPerPeriod: (amount: string) => `${amount} reaches these debts every pay period: their paces plus the extra.`,
    debtFreeAfter: (n: number, date: string) =>
      `Every debt paid off after ${n} pay period${n === 1 ? "" : "s"} under either order, by ${date}.`,
    debtNothingFlowing:
      "Nothing reaches these debts yet: none has a target date, so none has a pace of its own, and there is no extra.",
    debtBeyondHorizon: (n: number) => `At this rate the debts are not paid off within ${n} pay periods.`,
    debtSameTotalNote:
      "The number of periods is the same under both orders: the same money reaches the debts every period, whichever debt it lands on first. What differs is which debt finishes when.",
    avalancheTitle: "Largest balance first",
    avalancheSubtitle: "Avalanche: the extra goes to the debt with the largest remaining balance.",
    snowballTitle: "Smallest balance first",
    snowballSubtitle: "Snowball: the extra goes to the debt with the smallest remaining balance.",
    debtPace: (amount: string) => `${amount} per pay period on its own`,
    debtNoPace: "No target date: no pace of its own",
    debtPaidOffIn: (n: number, date: string) => `Paid off in period ${n} · ${date}`,
    debtNotWithinHorizon: (n: number) => `Not paid off within ${n} pay periods`,
  },
  reports: {
    title: "Reports",
    description: (code: string) => `Everything in ${code}, converted at current rates.`,
    spendingByCategory: "Spending by category",
    nothingSpentTitle: "Nothing spent this period",
    nothingSpentDescription: "Categorised spending shows up here as soon as you log it.",
    lastNPeriods: (n: number) => `Last ${n} pay periods`,
    averagePerPeriod: (amount: string, n: number) =>
      `${amount} average over ${n} completed period${n === 1 ? "" : "s"}`,
    periodSoFar: "so far",
    peakPeriod: "peak period",
    thisPeriod: "This period",
    categoriesTouched: (n: number) => `${n} categor${n === 1 ? "y" : "ies"} touched`,
    acrossNPeriods: (n: number) => `Across ${n} periods`,
    incomeThisPeriod: "Income this period",
    tooltipOut: (amount: string) => `${amount} out`,
    tooltipIn: (amount: string) => `${amount} in`,
    monthlySectionTitle: "Monthly spending",
    monthlySectionDescription:
      "Calendar months, not pay periods - a longer view alongside the periods above.",
    monthlyTrendTitle: (n: number) => `Last ${n} completed month${n === 1 ? "" : "s"}`,
    monthlyAverageSummary: (amount: string, n: number) =>
      `${amount} average normal spending across ${n} month${n === 1 ? "" : "s"}`,
    monthlyPeakLabel: "peak month",
    monthlyTooltipNormal: (amount: string) => `${amount} normal spending`,
    monthlyTooltipSavings: (amount: string) => `${amount} savings & investing`,
    monthlyCategoryBreakdown: "Average monthly lifestyle spending by category",
    monthlyCommittedAverage: "Average monthly committed spending",
    monthlyCommittedHint:
      "Active subscriptions - actual charges when Cadence can match them, their scheduled amount otherwise.",
    monthlySavingsAverage: "Average monthly savings & investing",
    monthlySavingsHint:
      "Goal contributions, recurring contributions and Savings/Investment spending - kept separate from normal spending.",
    monthlyTotalOutflowAverage: "Average total cash outflow",
    monthlyNormalSpendingNote:
      "Normal spending is lifestyle plus committed spending only. Savings and investing are not included.",
    monthlyInsufficientTitle: "Monthly averages appear after three completed months of activity",
    monthlyInsufficientDescription: (n: number) =>
      n === 0
        ? "Log a few months of transactions and a monthly view will appear here."
        : `${n} completed month${n === 1 ? "" : "s"} tracked so far.`,
  },
  settingsPage: {
    title: "Settings",
    description: "A single-user ledger: one PIN, one display currency, one set of rules.",
    displayCurrencyTitle: "Display currency",
    displayCurrencyDescription: "Every figure in the app is converted into this currency.",
    languageThemeTitle: "Language and theme",
    languageThemeDescription: "On wider screens these sit in the header.",
    themeLabel: "Theme",
    exchangeRates: "Exchange rates",
    exchangeRatesDescription: "USD-based, cached for 24 hours, cross rates derived through USD.",
    usdTo: (code: string) => `USD to ${code}`,
    lastFetched: (datetime: string) => `Last fetched ${datetime}`,
    noRatesFetched: "No rates fetched yet",
    rateServiceUnreachable: " · the rate service was unreachable, using the last known values",
    rateSourceBpd: (date: string) => `from Banco Popular (${date})`,
    rateSourceOpenErApi: "from open.er-api.com (market rate)",
    goalProgress: "Goal progress",
    goalProgressDescription:
      "Goal totals are cached for speed. Contributions are the source of truth - rebuild the cache from them if anything looks off.",
    recalculateGoalTotals: "Recalculate goal totals",
    categorizeHistory: "Transaction categorization",
    categorizeHistoryDescription:
      "Imports from before automatic categorization was added may still be Uncategorized. Run the same merchant rules against them now - manually categorized transactions are never touched.",
    categorizeHistoryAction: "Categorize uncategorized expenses",
    emailConnections: "Email connections",
    emailConnectionsDescription:
      "Gmail and Outlook accounts Cadence pulls transactional emails from, staged on /review before they become transactions.",
    manageConnections: "Manage connections",
    session: "Session",
    sessionDescription: (tz: string, currencies: string) =>
      `Pay periods are resolved in ${tz}. Currencies available: ${currencies}.`,
    lockCadence: "Lock Cadence",
    connectionsTitle: "Connections",
    connectionsDescription: "Gmail and Outlook accounts Cadence pulls transactional emails from.",
    syncNow: "Sync now",
    reviewQueue: "Review queue",
    connectedTo: (x: string) => `Connected ${x}.`,
    gmailDescription: "Reads receipts, invoices and subscription emails (gmail.readonly).",
    outlookDescription: "Reads the same kinds of emails via Microsoft Graph (Mail.Read).",
    neverSynced: "Never synced",
    lastSynced: (datetime: string) => `Last synced ${datetime}`,
    noAccountConnected: "No account connected yet.",
    disconnectTitle: (email: string) => `Disconnect ${email}?`,
    disconnectDescription:
      "Cadence stops syncing this mailbox. Transactions already staged or approved from it are kept.",
    disconnect: "Disconnect",
    connectAccount: (label: string) => `Connect ${label} account`,
    goalsRecalculated: (count: number) => `Recalculated ${count} goal${count === 1 ? "" : "s"}`,
    categorizationBackfilled: (count: number) =>
      count === 0
        ? "No uncategorized expenses matched a rule"
        : `Categorized ${count} transaction${count === 1 ? "" : "s"}`,
    showingIn: (code: string) => `Showing amounts in ${code}`,
    nothingToDisconnect: "Nothing to disconnect",
    connectionNoLongerExists: "That connection no longer exists",
    disconnected: (email: string) => `Disconnected ${email}`,
    connectFirst: "Connect a Gmail or Outlook account first",
    syncedResult: (accounts: number, staged: number, accountsFailed = 0, messagesFailed = 0) =>
      `Synced ${accounts} account${accounts === 1 ? "" : "s"} - ${staged} new item${staged === 1 ? "" : "s"} staged` +
      (accountsFailed > 0
        ? `. ${accountsFailed} account${accountsFailed === 1 ? "" : "s"} failed to sync`
        : "") +
      (messagesFailed > 0
        ? `. ${messagesFailed} email${messagesFailed === 1 ? "" : "s"} could not be read and will be retried on the next sync`
        : "") +
      (accountsFailed > 0 || messagesFailed > 0 ? "." : ""),
    planningPreferencesTitle: "Planning preferences",
    planningPreferencesDescription:
      "How the payday planner sizes your protected buffer and carries money forward.",
    bufferPercentLabel: "Buffer percentage",
    bufferPercentHint: "Percent of each check-in's income reserved as a buffer by default.",
    bufferFloorLabel: "Fixed minimum buffer",
    bufferFloorHint:
      "The smallest buffer kept for each account that receives income in a check-in, so two income accounts reserve two floors. The larger of this and the percentage counts for each account.",
    carryoverDefaultLabel: "Include carryover by default",
    carryoverDefaultHint:
      "When on, unspent money from the previous period's budget pre-fills as included carryover in each new check-in.",
    historyStartLabel: "Count history from",
    historyStartHint:
      "If your situation changed - a new job, a move, a new household - set this so Cadence's averages read only what came after it: Afford's income projection, the payday check-in's category suggestions, the Reports average per pay period, and the monthly spending pace and averages. History counts from the first pay period that starts on or after this date, and the monthly figures from the first month that does. Leave blank to use your full history.",
    planningPreferencesSaved: "Planning preferences saved",
    essentialCategoriesTitle: "Essential fixed categories",
    essentialCategoriesDescription:
      "Categories marked essential fixed are reserved in the payday plan before flexible category suggestions.",
    noEligibleCategories: "No expense categories available to configure.",
    essentialToggleAria: (name: string) => `Mark ${name} as essential fixed`,
    categoryNoLongerExists: "That category no longer exists",
    categoryMarkedEssential: "Marked as essential fixed",
    categoryUnmarkedEssential: "No longer essential fixed",
    categoriesTitle: "Categories",
    categoriesDescription:
      "Add, rename, or recolor the categories transactions, recurring items, and budgets are filed under, and remove the ones you don't use.",
    manageCategories: "Manage categories",
    categoriesPageDescription:
      "Every transaction, recurring item, and per-category budget is filed under one of these. Removing a category still in use moves its rows somewhere first, so nothing becomes uncategorized by accident.",
    newCategory: "New category",
    editCategory: "Edit category",
    addCategory: "Add category",
    saveCategory: "Save changes",
    categoryNamePlaceholder: "Pets",
    categoryKind: "Kind",
    categoryColor: "Color",
    renameHint:
      "CSV import rules look categories up by name, so renaming one changes where those imports land.",
    kindLockedHint: (n: number) =>
      `Kind can't change while ${n} transaction${n === 1 ? " is" : "s are"} filed under it.`,
    usageTransactions: (n: number) => `${n} transaction${n === 1 ? "" : "s"}`,
    usageRecurringItems: (n: number) => `${n} recurring item${n === 1 ? "" : "s"}`,
    usageBudgets: (n: number) => `${n} period budget${n === 1 ? "" : "s"}`,
    inUse: "In use",
    notInUse: "Not in use",
    protectedBadge: "Protected",
    protectedSubscriptionHint: (name: string) =>
      `${name} can't be removed: safe to spend and the period budget treat spending in it as money the payday plan already set aside.`,
    protectedSavingsHint: (name: string) =>
      `${name} can't be removed: the monthly pace files saving under it, and every goal contribution logged by hand lands there.`,
    categoryActionsFor: (name: string) => `Actions for ${name}`,
    deleteCategoryTitle: (name: string) => `Remove ${name}?`,
    deleteCategoryUnused: "Nothing is filed under it, so it goes straight away.",
    removeCategory: "Remove",
    reassignTitle: (name: string) => `Move what's filed under ${name}`,
    reassignDescription:
      "These rows still point at it. Pick where they go; the category is removed once they've moved.",
    willMove: "moves",
    willBeCleared: "cleared",
    budgetsMergedHint: "Each budget is added to the budget of the category you move to, for the same period.",
    moveTo: "Move to",
    moveAndRemove: "Move and remove",
    categoryCreated: (name: string) => `Added ${name}`,
    categoryUpdated: (name: string) => `Updated ${name}`,
    categoryDeleted: (name: string) => `Removed ${name}`,
    categoryReassigned: (name: string, rows: number, budgets: number) =>
      budgets > 0
        ? `Moved ${rows} row${rows === 1 ? "" : "s"}, merged in ${budgets} budget${budgets === 1 ? "" : "s"} and removed ${name}`
        : `Moved ${rows} row${rows === 1 ? "" : "s"} and removed ${name}`,
    categoryNameTaken: "A category with that name already exists",
    categoryKindInUse: (n: number) =>
      `Kind can't change while ${n} transaction${n === 1 ? " is" : "s are"} filed under this category`,
    categoryInUse: "That category still has rows filed under it - move them first",
    categoryTargetNoLongerExists: "The category to move them to no longer exists",
    exportTitle: "Export data",
    exportDescription:
      "Download everything Cadence tracks as a ZIP of CSV files - one per data type, openable in any spreadsheet. transactions.csv is in the format the CSV importer reads, so it can be brought back in; the rest are complete backups.",
    exportAll: "Export all",
    categorySameTarget: "Pick a different category to move them to",
    categoryKindMismatch: "Pick a category of the same kind to move them to",
    pinTitle: "PIN",
    pinDescription:
      "Change the PIN that unlocks Cadence. If you forget it, the unlock screen offers recovery when RECOVERY_SECRET is set in the server environment.",
    currentPin: "Current PIN",
    newPin: "New PIN",
    confirmNewPin: "Confirm new PIN",
    changePin: "Change PIN",
    pinChanged: "PIN changed",
    currentPinWrong: "That isn't the current PIN",
  },
  review: {
    title: "Review queue",
    pendingItems: (n: number) => `${n} pending item${n === 1 ? "" : "s"} from connected inboxes.`,
    hideReviewed: "Hide reviewed",
    showReviewed: "Show reviewed",
    addAccountFirstTitle: "Add an account first",
    needAccountDescription: "Approving a staged item needs somewhere to put it.",
    goToAccounts: "Go to accounts",
    nothingToReviewTitle: "Nothing to review",
    noStagedYet: "No staged items yet - connect an inbox and sync to get started.",
    noPendingItems: 'No pending items. Approved and rejected items stay hidden - use "Show reviewed" to see them.',
    manageConnections: "Manage connections",
    colAmount: "Amount",
    colAccount: "Account",
    colCategory: "Category",
    colActions: "Actions",
    approved: "Approved",
    rejected: "Rejected",
    pickAccountFirst: "Pick an account before approving",
    editAria: "Edit",
    reject: "Reject",
    approve: "Approve",
    approvedToast: "Approved",
    rejectedToast: "Rejected",
    pickAnAccount: "Pick an account",
    noCategory: "No category",
    editStagedTitle: "Edit staged item",
    editStagedDescription: "Changes are saved but stay pending until you approve.",
    stagedSaved: "Saved",
    itemNoLongerExists: "That item no longer exists",
    alreadyReviewed: "This item was already reviewed",
    accountNoLongerExists: "That account no longer exists",
    accountNoLongerActive: "That account is archived - pick an active one",
    transactionAlreadyExists: "This transaction already exists",
    nothingToReject: "Nothing to reject",
    postedMatchNeedsChoice: "This matches a charge already in the ledger - say whether it's the posted charge or a different one",
    keptAsPosted: "Kept the posted charge - the receipt wasn't added twice",
    keptAsPostedUpdated: (from: string, to: string) => `Kept the posted charge, now ${to} (was ${from})`,
  },
  inbox: {
    title: "Inbox",
    description:
      "Everything Cadence has noticed that is still waiting on you, from every part of the app in one place. Each item also stays where it came from until it is resolved.",
    pendingCount: (count: number) =>
      count === 1 ? "1 item to review" : `${count} items to review`,
    emptyTitle: "Nothing to review",
    emptyDescription:
      "Recurring items are posting, your Afford plans still fit, no untracked patterns turned up, every goal plan is on its roadmap, no goal is short of what its plan set aside as a period closes, and every goal has room ahead to reach its target date.",
    /** The empty Inbox when dismissals, not a clean bill, are why nothing is listed. */
    emptyDescriptionDismissed: (count: number) =>
      count === 1
        ? "Nothing else is waiting. 1 item you dismissed is hidden here; it stays where it came from until it is resolved."
        : `Nothing else is waiting. ${count} items you dismissed are hidden here; each stays where it came from until it is resolved.`,
    /** Severity headings. "Advisory" is how Afford describes a check that blocks nothing. */
    severityCritical: "Needs attention",
    severityAdvisory: "Advisory",
    severityCriticalHint: "Money already committed is not where the plan says it is.",
    severityAdvisoryHint: "Worth a look; nothing is blocked or changed by it.",
    sourceNotPosting: "Recurring",
    sourceAffordViability: "Afford",
    sourceRecurringSuggestion: "Looks recurring",
    sourceGoalBehind: "Goals",
    sourceGoalForecast: "Goal forecast",
    dismiss: "Dismiss",
    dismissHint: "Remove from the Inbox. A different or later problem will still show up. Where it came from is unchanged.",
    dismissed: "Dismissed. A different or later problem will still show up in the Inbox.",
    dismissUnknown: "That item is no longer in the Inbox",
    /** The link each insight carries to the surface that can resolve it. */
    openRecurring: "Fix on the recurring page",
    openRecurringPage: "Open the recurring page",
    openFromAfford: "See it on the recurring page",
    openSuggestion: "Review on the recurring page",
    openGoal: "Open the goal",
    // Titles and evidence labels, per source. Evidence carries the figures
    // that triggered the insight, formatted by the page.
    notPostingTitle: (name: string) => `${name} is not posting`,
    notPostingReason: "Why",
    notPostingDue: "Still due",
    notPostingKind: "Kind",
    notPostingKindSubscription: "Subscription",
    notPostingKindContribution: "Goal contribution",
    postingRunFailedTitle: "The last recurring posting run failed",
    postingRunFailedEffect: "Effect",
    postingRunFailedEffectValue: "Recurring items are not being posted until a run succeeds.",
    affordTitle: (name: string) => `${name} from Afford no longer fits`,
    affordShortfall: "Short by",
    affordPeriod: "In",
    affordCheck: "Check that fails",
    affordCheckAccount: (account: string) => `${account} would end the period below its buffer`,
    affordCheckFlexible: "Available for flexible categories would go into deficit",
    affordHeadroom: "Room left after it",
    affordInstallment: "Installment due there",
    suggestionTitle: (name: string) => `${name} looks recurring`,
    suggestionAmount: "Last charged",
    suggestionCadence: "Cadence",
    suggestionCharges: "Charges",
    suggestionChargesValue: (count: number, first: string, last: string) =>
      `${count}, ${first} to ${last}`,
    suggestionAccount: "Account",
    suggestionNext: "Next expected",
    goalTitle: (name: string) => `The plan for ${name} is behind its roadmap`,
    goalFollowThroughTitle: (name: string) => `${name}: planned but not yet contributed`,
    goalBehindBy: "Behind by",
    goalRoadmap: "Roadmap, by hand",
    goalPlanned: "Planned",
    goalNotContributed: "Not yet contributed",
    goalScheduled: "Recurring contributions",
    goalContributed: "Contributed",
    goalPeriod: "Period",
    goalTarget: "Target date",
    goalRoomShortfall: "Room couldn't cover",
    forecastTitle: (name: string) => `${name} is at risk before its target date`,
    forecastShortfall: "Short by",
    forecastPeriod: "In",
    forecastPace: "Roadmap pace",
    forecastScheduled: "Recurring contributions",
    forecastRoom: "Room could give",
    forecastRoomOn: (account: string) => `Room on ${account}`,
    forecastAccounts: "Accounts with room",
    forecastNoRoom: "none",
    forecastTarget: "Target date",
  },
  payday: {
    bannerTitle: "Payday check-in ready",
    bannerDescription:
      "Confirm balances, record this period's income, and plan until your next payday.",
    startCheckin: "Start payday check-in",
    planThisPeriod: "Plan this period",
    checkInForPeriod: "Check in for this period",
    dismissForToday: "Not now",
    reviewConfirmedPlan: "Review this period's plan",
    /** The wizard's title on a phone, where the period moves into the description. */
    wizardName: "Payday check-in",
    wizardTitle: (periodLabel: string) => `Payday check-in - ${periodLabel}`,
    stepOf: (step: number, total: number) => `Step ${step} of ${total}`,
    back: "Back",
    next: "Next",
    cancel: "Cancel",

    step1Title: "Confirm account balances",
    step1Description:
      "This is a reconciliation check only - it never creates income or expenses.",
    step1BalanceMeaning:
      "“Reported balance” is what the account held the day before this period's pay landed - not what it holds now, after the pay and whatever was spent since. The ledger balance shown for each account is the ledger on that day (this check-in's own income, and every row dated after it, are left out), so start from it and change it only if you know the ledger is wrong.",
    balanceMeaningDisclosure: "What counts as the reported balance?",
    ledgerBalance: "Ledger balance",
    ledgerBalanceOn: (date: string) => `Ledger balance on ${date}`,
    reportedBalance: "Reported balance",
    matchesLedger: "Matches ledger",
    aboveLedger: (amount: string) => `${amount} above ledger`,
    belowLedger: (amount: string) => `${amount} below ledger`,
    manageAccountsLink: "Manage accounts",
    noActiveAccountsTitle: "No active accounts",
    noActiveAccountsDescription: "Add or restore an account before starting a check-in.",

    step2Title: "Record income received",
    step2Description:
      "Optional per account - leave any account at zero if nothing came in. If part of it is one-off, like a bonus, enter that part too: it counts this period, and later periods don't expect it again.",
    incomeAmount: "Income received",
    oneOffIncomeAmount: "Of which one-off",
    oneOffIncomeTooHigh: "The one-off part can't be more than the income received.",
    incomeNotePlaceholder: "Salary, freelance payment, bonus...",
    totalIncome: "Total income",

    step3Title: "Review commitments and goals",
    subscriptionsDue: "Subscriptions due before next payday",
    contributionsDue: "Recurring contributions due before next payday",
    noSubscriptionsDue: "No subscriptions due before next payday.",
    noContributionsDue: "No recurring contributions due before next payday.",
    bufferByAccountHeading: "Protected buffer by account",
    bufferByAccountDescription:
      "Each account keeps its own buffer out of the income it received. Move a subscription to another account to change what it has to cover.",
    noIncomeAccountsYet:
      "No income recorded yet - enter what each account received in step 2 to see its buffer.",
    accountIncomeReceived: "Income received",
    accountSubscriptionsDue: "Subscriptions and contributions",
    accountLeftAfterSubscriptions: "Left after subscriptions and contributions",
    accountReportedSupports: "Supports (from your reported balance)",
    accountReportedBelowProjection: (amount: string) =>
      `Your reported balance supports ${amount} less than this period's income projection - likely money that already left this account before this check-in.`,
    accountSuggestedBuffer: "Suggested buffer",
    accountNoSubscriptionsDue: "Nothing due from this account before next payday.",
    accountAboveBuffer: (amount: string) => `${amount} above its buffer`,
    accountBelowBuffer: (amount: string) =>
      `Posting everything due here would fall short by ${amount}.`,
    accountBelowBufferWithAlternative: (amount: string, accountName: string) =>
      `Posting everything due here would fall short by ${amount} - ${accountName} has more room this period.`,
    coverShortfallSuggestion: (amount: string, accountName: string) =>
      `Cover it: move ${amount} from ${accountName}.`,
    coverShortfallPartialSuggestion: (amount: string, accountName: string) =>
      `Cover part of it: move ${amount} from ${accountName} - not enough there to close the gap in full.`,
    coverShortfallButton: "Cover it",
    subscriptionAccountLabel: (name: string) => `Account for ${name}`,
    unfundedSubscriptionsHeading: "Not covered by an account with income",
    unfundedSubscriptionsDescription:
      "These are due before next payday but their account received no income this check-in. Move them to an account that did.",
    alreadyPaidThisPeriod: "Already paid this period",
    wontPostHeading: "Not counted: posting will skip these",
    wontPostDescription:
      "Nothing will be charged for them until the reason is fixed on the Recurring page, so this plan leaves them out.",
    goalReachedKept: (amount: string) =>
      `Reached since this plan was confirmed - its ${amount} stays in the plan.`,
    archivedAccountNote: "archived, kept for the record",
    overdueBadge: "Overdue",
    chargesThisPeriod: (count: number, each: string) => `${count} charges of ${each}`,
    // Income earmarked for a recurring payment (src/lib/earmarks.ts).
    coveredBy: (amount: string, deposit: string) => `${amount} covered by ${deposit}`,
    depositOf: (date: string) => `the deposit of ${date}`,
    goalsHeading: "Goal roadmap",
    goalsDescription:
      "Each goal is funded from the accounts with money to spare after their subscriptions, recurring contributions and buffer, in proportion to how much room each one has. Adjust any account's share; the goal's total is their sum.",
    noGoalsToReserve: "No goals to reserve for this period.",
    roadmapAmount: "Roadmap amount",
    roadmapScheduled: (amount: string) => `+ ${amount} from recurring contributions`,
    remainingBalanceNoDate: "Remaining balance (no target date)",
    remainingBalanceNoDateHint:
      "recommended in full as far as the accounts' room allows - there is no date to pace it against",
    plannedAmount: "Planned amount",
    goalPlannedTotal: "Planned total",
    goalFundingRecommended: "Recommended",
    goalFundingAccountLabel: (goalName: string, accountName: string) =>
      `${goalName} from ${accountName}`,
    goalFundingRoom: (amount: string, sharePercent: number) =>
      `${amount} to spare after its subscriptions, contributions and buffer · ${sharePercent}% of the room`,
    goalFundingRoomAfterEarlierGoals: (amount: string, sharePercent: number) =>
      `${amount} still to spare after the goals above · ${sharePercent}% of the room`,
    goalFundingNoRoomLeft: "Nothing left to spare after the goals above",
    goalFundingLeadAccount: (accountName: string) =>
      `${accountName} has more room this period after its subscriptions, contributions and buffer, so it takes the larger share.`,
    goalFundingNoRoom:
      "No account has money to spare after its subscriptions, contributions and buffer this period, so nothing can be set aside for this goal from surplus.",
    goalFundingShortfall: (free: string, short: string) =>
      `Only ${free} is to spare across your accounts - ${short} of this goal's roadmap amount can't be funded from surplus this period.`,
    goalOnTrack: "On track with the roadmap",
    goalBehind: (amount: string) => `${amount} behind the target roadmap`,
    goalAhead: (amount: string) => `${amount} ahead of the target roadmap`,
    goalRemainingFunded: "Covers the whole remaining balance",
    goalRemainingLeft: (amount: string) => `${amount} of the remaining balance left for a later period`,
    goalRemainingOver: (amount: string) => `${amount} more than the remaining balance`,
    bufferZeroWarning: "This plan leaves no protected buffer for unexpected spending.",
    essentialCategoriesHeading: "Essential fixed spending",
    noEssentialCategoriesConfigured:
      "No categories are marked essential fixed yet - configure them in Settings.",
    carryoverHeading: "Carryover from last period",
    carryoverAvailable: (amount: string) => `${amount} unspent from last period's budget`,
    carryoverUnavailable:
      "No prior period budget to measure carryover against - this plan is funded by income only.",
    carryoverProvisional: (amount: string) =>
      `${amount} unspent so far from last period's budget. Last period has not ended yet, so this is provisional: the plan counts none of it now, and counts what that period really leaves once it is over.`,
    carryoverIncluded: "Include in this plan",
    summaryIncome: "Income",
    summaryCarryover: "Included carryover",
    summaryCarryoverProvisional: (amount: string) => `${amount} provisional - counted once last period ends`,
    summaryCushion: "Already in your accounts",
    summaryCushionHint: "What your accounts held before this pay. Kept as a cushion - not counted in this plan.",
    summarySubscriptions: "Subscriptions",
    summaryContributions: "Recurring contributions",
    summaryGoals: "Goal plan",
    summaryEssential: "Essential fixed",
    summaryBuffer: "Protected buffer",
    summaryReconciliationCap: "Capped by your reported balance",
    summaryAvailable: "Available for flexible categories",
    deficitWarning: (amount: string) =>
      `This plan is ${amount} short - something above has to give before you can allocate flexible categories.`,

    step4Title: "Plan flexible categories",
    noSuggestionsYetNote:
      "No spending history yet, so there are no suggested amounts. Enter what you want to allow for each category, or leave them at 0 and set budgets later on the Budgets page - the money in your accounts is unaffected either way.",
    suggested: "Suggested",
    basisLastBudget: "last budget",
    basisAverage: "average",
    basisNone: "not enough history",
    flexibleAllocated: "Allocated",
    flexibleUnallocated: "Unallocated",
    flexibleUnallocatedCarries:
      "Not written as a budget. What stays unallocated, and whatever the budgets leave unspent, carries to the next period's check-in.",
    flexibleDeficitNote:
      "This plan leaves nothing for flexible categories, so every suggestion is scaled to 0. Free up money in step 3, or leave these at 0.",
    flexibleOverallocated: (amount: string) => `${amount} overallocated`,
    noFlexibleCategoriesConfigured:
      "No flexible categories available - every expense category is either essential fixed or excluded.",
    acknowledgeDeficitLabel:
      "I understand this plan is short and choices above need to change or spending will be tighter than planned.",

    step5Title: "Confirm your plan",
    confirmSnapshotsNote:
      "Balance snapshots are recorded for audit only - they never change account balances.",
    confirmIncomeNote: (counts: { created: number; updated: number; removed: number }, amount: string) => {
      const parts = [
        counts.created > 0 ? `${counts.created} created` : null,
        counts.updated > 0 ? `${counts.updated} updated` : null,
        counts.removed > 0 ? `${counts.removed} removed` : null,
      ].filter((part): part is string => part !== null);
      if (parts.length === 0) return "No income transaction is created or changed.";
      const changed = counts.created + counts.updated + counts.removed;
      return `Income transactions, ${amount} in total: ${parts.join(", ")}${changed === counts.created ? "" : " - the ones this check-in recorded before are changed in place, not added again"}.`;
    },
    confirmUnallocatedNote: (amount: string) =>
      `${amount} stays unallocated: it is not written as a budget, and it carries to the next period's check-in with whatever the budgets leave unspent.`,
    confirmCushionNote: (amount: string) =>
      `${amount} was already in your accounts before this pay. It stays there as a cushion and is not counted in this plan.`,
    confirmBudgetsNote: (count: number) =>
      `${count} category budget${count === 1 ? "" : "s"} will be created or updated for this period.`,
    confirmReservedNote:
      "Subscriptions, recurring contributions, and goal amounts are reserved in the plan but not logged as actual transactions or contributions.",
    confirmNoAllocationsNote:
      "No category amounts are allocated yet - you can set or change category budgets any time on the Budgets page.",
    noAllocationsSavedNote: "No category allocations saved yet.",
    setBudgetsLink: "Set budgets",
    acknowledgeZeroBufferLabel: "I understand this plan leaves no protected buffer.",
    confirmPlan: "Confirm plan",
    checkinConfirmed: "Payday check-in confirmed",
    checkinConfirmedScaled: (from: string, to: string) =>
      `Payday check-in confirmed. Flexible budgets were scaled down from ${from} to ${to} - what your reported balance supports.`,
    editConfirmedPlanNote:
      "You already confirmed this period's check-in - saving again updates it in place.",

    couldNotReadPlan: "Could not read the plan - try again",
    noActiveAccounts: "Add at least one active account before checking in",
    acknowledgeDeficitFirst: "Acknowledge the deficit/overallocation warning before confirming",
    confirmedMeanwhile:
      "This check-in was confirmed from another window or a second tap while this one was being saved, so nothing was saved this time. Close the check-in and open it again to see the plan that was saved.",
    acknowledgeZeroBufferFirst: "Acknowledge the zero-buffer warning before confirming",
  },
};

export type Dictionary = typeof en;
