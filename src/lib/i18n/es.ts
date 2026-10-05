import type { Dictionary } from "./en";

/** "1 período de pago comparable", "4 períodos de pago comparables". */
function comparablePeriodsEs(count: number): string {
  return count === 1 ? "1 período de pago comparable" : `${count} períodos de pago comparables`;
}

/** Cómo se llegó a un ingreso proyectado, para una frase que dice "...se proyecta como <esto>". */
function incomeBasisEs(periods: number): string {
  return periods === 0
    ? "cero, porque ningún período de pago comparable tiene ingresos todavía"
    : `el promedio de ${comparablePeriodsEs(periods)}`;
}

/** "del día 16", o "del último día del mes" para un ancla de 31 (recortada en meses más cortos). */
function dayOfMonthEs(day: number): string {
  return day >= 31 ? "del último día del mes" : `del día ${day}`;
}

export const es = {
  common: {
    // Escrituras de dinero rechazadas (R20, R29, R30): no se guardó nada.
    duplicateEntry: "Esto parece el registro que acabas de guardar",
    ratesUnavailable:
      "Las tasas de cambio no están disponibles ahora, así que este monto no se puede convertir. No se guardó nada; inténtalo más tarde.",
    roundsToZero: (entered: string, currency: string) =>
      `${entered} equivale a 0.00 en ${currency}, así que no hay nada que guardar. Ingresa un monto mayor.`,
    close: "Cerrar",
    save: "Guardar",
    cancel: "Cancelar",
    delete: "Eliminar",
    edit: "Editar",
    // Ingreso apartado para un pago recurrente (src/lib/earmarks.ts).
    coveredBy: (amount: string, deposit: string) => `${amount} cubierto por ${deposit}`,
    depositOf: (date: string) => `el depósito del ${date}`,
    add: "Agregar",
    keepIt: "Conservar",
    saved: "Guardado",
    deleted: "Eliminado",
    done: "Listo",
    name: "Nombre",
    date: "Fecha",
    amount: "Monto",
    currency: "Moneda",
    category: "Categoría",
    note: "Nota",
    type: "Tipo",
    account: "Cuenta",
    optional: "Opcional",
    checkFormAndRetry: "Revisa el formulario e intenta de nuevo",
    description: "Descripción",
    source: "Fuente",
    uncategorized: "Sin categoría",
    nothingToDelete: "Nada que eliminar",
    pickAnAccount: "Elige una cuenta",
    pickACategory: "Elige una categoría",
    pickAGoal: "Elige una meta",
    noCategory: "Sin categoría",
    today: "hoy",
    tomorrow: "mañana",
    yesterday: "ayer",
    inDays: (n: number) => `en ${n} días`,
    daysAgo: (n: number) => `hace ${n} días`,
    exploratoryNote: (subject: string) =>
      `Esta ${subject} es exploratoria: nada aquí se aplica ni se guarda hasta que hagas una acción explícita y aparte.`,
    accountTypeLabels: {
      CHECKING: "Corriente",
      SAVINGS: "Ahorros",
      CASH: "Efectivo",
      OTHER: "Otro",
    } as Record<string, string>,
    transactionTypeLabels: {
      EXPENSE: "Gasto",
      INCOME: "Ingreso",
      TRANSFER: "Transferencia",
      OPENING_BALANCE: "Saldo inicial",
      EXTERNAL_TRANSFER: "Transferencia externa",
    } as Record<string, string>,
    sourceLabels: {
      MANUAL: "Manual",
      CSV: "CSV",
      GMAIL: "Gmail",
      OUTLOOK: "Outlook",
      PAYPAL: "PayPal",
      PAYDAY_CHECKIN: "Chequeo de pago",
      OPENING_BALANCE: "Saldo inicial",
      RECURRING: "Recurrente",
    } as Record<string, string>,
    frequencyLabels: {
      WEEKLY: "Semanal",
      BIWEEKLY: "Cada 2 semanas",
      SEMI_MONTHLY: "Dos veces al mes",
      MONTHLY: "Mensual",
      YEARLY: "Anual",
    } as Record<string, string>,
    categoryKindLabels: {
      EXPENSE: "Gasto",
      INCOME: "Ingreso",
    },
    recurringKindLabels: {
      SUBSCRIPTION: "Suscripción",
      CONTRIBUTION: "Aporte",
    } as Record<string, string>,
  },
  dataExport: {
    yes: "Sí",
    no: "No",
    accountStatusLabels: {
      ACTIVE: "Activa",
      ARCHIVED: "Archivada",
    } as Record<string, string>,
    transferDirectionLabels: {
      OUT: "Salida",
      IN: "Entrada",
    } as Record<string, string>,
    payPeriodLabels: {
      A: "1 al 15",
      B: "16 a fin de mes",
    } as Record<string, string>,
    headers: {
      id: "ID",
      date: "Fecha",
      amount: "Monto",
      description: "Descripción",
      note: "Nota",
      account: "Cuenta",
      currency: "Moneda",
      category: "Categoría",
      type: "Tipo",
      source: "Origen",
      transferDirection: "Dirección de transferencia",
      transferGroup: "Grupo de transferencia",
      externalId: "ID externo",
      isExtraordinary: "Gasto único",
      isOneOffIncome: "Ingreso único",
      yourShare: "Tu parte",
      reimburses: "Reembolsa",
      originalAmount: "Monto registrado",
      originalCurrency: "Moneda registrada",
      rate: "Tasa",
      createdAt: "Creado el",
      updatedAt: "Actualizado el",
      name: "Nombre",
      targetAmount: "Monto objetivo",
      targetDate: "Fecha objetivo",
      savedAmount: "Ahorrado hasta ahora",
      achievedAt: "Alcanzada el",
      goal: "Meta",
      recurringItem: "Ítem recurrente",
      recurringExternalId: "Publicado con la transacción",
      kind: "Tipo",
      frequency: "Frecuencia",
      nextDate: "Próxima fecha",
      anchorDay: "Día de vencimiento del mes",
      active: "Activo",
      remainingOccurrences: "Pagos restantes",
      fromAfford: "Desde Afford",
      detectedFrom: "Detectado desde",
      year: "Año",
      month: "Mes",
      period: "Periodo de pago",
      status: "Estado",
      archivedAt: "Archivada el",
      color: "Color",
      icon: "Ícono",
      isSubscriptionDefault: "Categoría de suscripciones",
      isSavingsDefault: "Categoría de ahorro",
      isEssentialFixed: "Fijo esencial",
    },
  },
  nav: {
    dashboard:"Panel",
    transactions: "Transacciones",
    review: "Revisión",
    accounts: "Cuentas",
    budgets: "Presupuestos",
    recurring: "Recurrentes",
    afford: "Cuotas",
    goals: "Metas",
    reports: "Informes",
    settings: "Ajustes",
    inbox: "Bandeja",
    plan: "Plan",
    more: "Más",
    tabBarLabel: "Navegación principal",
    badgeLabel: (count: number) =>
      count === 1 ? "1 por revisar" : `${count} por revisar`,
  },
  more: {
    title: "Más",
    description: "Mantén el libro, mira atrás y configura Cadence.",
  },
  shell: {
    paidTwiceAMonth: (range: string) => `Pago dos veces al mes. Los presupuestos van del ${range}.`,
    periodRangeFirstHalf: "1 al 15",
    periodRangeSecondHalf: "16 al final del mes",
    periodClosed: "Periodo cerrado",
    daysLeft: (n: number) => `${n} día${n === 1 ? "" : "s"} restante${n === 1 ? "" : "s"}`,
    lockCadenceAria: "Bloquear Cadence",
    toggleThemeAria: "Cambiar modo claro y oscuro",
    displayCurrencyLabel: "Moneda de visualización",
    languageLabel: "Idioma",
    staleRatesTitle: "Las cifras convertidas pueden estar desactualizadas",
    staleRatesSince: (datetime: string) =>
      `Las tasas de cambio no se pudieron actualizar, así que los montos convertidos usan las últimas tasas obtenidas el ${datetime}. DOP y EUR pueden venir de una tasa más reciente del Banco Popular.`,
    staleRatesNeverFetched:
      "Las tasas de cambio no se pudieron actualizar y aún no se ha obtenido ninguna, así que todo monto convertido es una estimación.",
  },
  login: {
    createSubtitle:
      "Crea un PIN para bloquear este libro contable. Se guarda en la sesión de este dispositivo, cifrado en tu propia base de datos.",
    loginSubtitle: "Ingresa tu PIN para abrir el libro contable.",
    newPin: "PIN nuevo",
    pin: "PIN",
    confirm: "Confirmar",
    confirmPinAria: "Confirmar PIN",
    digitsHint: "De 4 a 6 dígitos",
    setPinAndContinue: "Crear PIN y continuar",
    unlock: "Desbloquear",
    pinAlreadySet: "Ya hay un PIN configurado para esta app",
    entriesMustMatch: "Ambas entradas deben coincidir",
    pinDoesNotMatch: "Ese PIN no coincide",
    forgotPin: "¿Olvidaste tu PIN?",
    recoverSubtitle:
      "Ingresa el secreto de recuperación del entorno del servidor (RECOVERY_SECRET) y elige un PIN nuevo.",
    recoverySecret: "Secreto de recuperación",
    setNewPin: "Crear PIN nuevo",
    backToUnlock: "Volver a desbloquear",
    recoveryRejected: "Ese secreto de recuperación no coincide",
    recoveryNotConfigured:
      "La recuperación del PIN no está configurada en esta instalación: primero define RECOVERY_SECRET en el entorno del servidor",
  },
  errorPage: {
    genericTitle: "Algo salió mal",
    genericDescription:
      "No se pudo cargar esta página. No se cambió nada; vuelve a intentarlo y, si sigue ocurriendo, el registro del servidor tiene los detalles.",
    ratesTitle: "No se pudieron cargar las tasas de cambio",
    ratesDescription:
      "Cadence no muestra una cifra convertida que no pueda respaldar, así que esta página queda en pausa. Las tasas se vuelven a consultar en la siguiente solicitud; inténtalo de nuevo en unos minutos.",
    tryAgain: "Intentar de nuevo",
  },
  dashboard: {
    notPostingTitle: (count: number) =>
      count === 1
        ? "1 elemento recurrente no se está registrando"
        : `${count} elementos recurrentes no se están registrando`,
    notPostingDescription:
      "Siguen pendientes, así que no se ha cobrado nada por ellos y faltan en tu total comprometido.",
    notPostingItem: (name: string, reason: string, date: string) =>
      `${name} - ${reason}, vence el ${date}`,
    notPostingReasonMissingAccount: "sin cuenta asignada",
    notPostingReasonMissingGoal: "sin meta asignada",
    notPostingReasonMissingAccountAndGoal: "sin cuenta ni meta asignadas",
    notPostingReasonAccountArchived: "su cuenta está archivada",
    notPostingReasonGoalAchieved: "su meta ya está completa",
    notPostingReasonRoundsToZero: "su monto queda en 0.00 en la moneda de su cuenta",
    waitingForRates: (count: number) =>
      `${count === 1 ? "1 pago recurrente en otra moneda está esperando" : `${count} pagos recurrentes en otra moneda están esperando`} las tasas de cambio. ${count === 1 ? "Se registrará" : "Se registrarán"} cuando haya tasas actuales disponibles.`,
    notPostingReasonFailed: "la última ejecución falló",
    notPostingLink: "Arreglar en la página de recurrentes",
    postingRunFailedTitle: "La última ejecución de registro de recurrentes falló",
    postingRunFailedDescription:
      "No se registró nada, así que los elementos recurrentes faltan en tus saldos y en tu total comprometido hasta que una ejecución se complete. Cadence lo intenta de nuevo en la siguiente solicitud.",
    postingRunFailedLink: "Ver el motivo en la Bandeja",
    affordShortTitle: (count: number) =>
      count === 1
        ? "1 compra desde Cuotas ya no encaja"
        : `${count} compras desde Cuotas ya no encajan`,
    affordShortDescription:
      "Revisado hoy - con tu promedio de ingresos actual, las tasas de cambio de hoy, tus compromisos y los estimados de metas - el margen con el que contaban sus pagos restantes se redujo. Nada se bloquea: la revisión es orientativa, como la de Cuotas.",
    affordShortItem: (name: string, amount: string, period: string) =>
      `${name} - faltan ${amount} en ${period}`,
    affordShortLink: "Verlas en la página de recurrentes",
    goalsHeading: "Metas",
    overdueNotPosted: "vencido, aún sin registrar",
    wontPostNotCounted: (reason: string) => `no se registrará: ${reason}`,
    plusOutsideBudget: (amount: string) =>
      `más ${amount} en suscripciones y ahorro, que el presupuesto no cubre`,
    allGoals: "Todas las metas",
    noGoalsTitle: "Aún no hay metas",
    noGoalsDescription:
      "Registra algo para lo que estás ahorrando y Cadence calcula lo que necesita cada periodo de pago.",
    createGoal: "Crear una meta",
    nextDays: (n: number) => `Próximos ${n} días`,
    nothingDue: "Nada vence la próxima semana.",
    periodPrefix: "Periodo",
    closed: "cerrado",
    daysLeftOfTotal: (remaining: number, total: number) =>
      `${remaining} de ${total} días restantes`,
    safeToSpendPerDay: "Disponible para gastar por día",
    leftForRest: "restante para el resto de este periodo",
    overThePlan: "sobre lo planeado para este periodo",
    setBudgetPrompt:
      "Define un presupuesto para este periodo y Cadence calcula cuánto puedes gastar cada día: el presupuesto menos lo que has gastado, entre los días que quedan.",
    setPeriodBudget: "Definir el presupuesto de este periodo",
    recommendedBudget: (amount: string) =>
      `Recomendado: ${amount} - lo que tu revisión de día de pago deja para categorías flexibles.`,
    recommendedUnallocated: (available: string, unallocated: string) =>
      `Recomendado: ${available} - lo que tu revisión de día de pago deja para categorías flexibles. ${unallocated} aún no está en ningún presupuesto:`,
    recommendedBudgetItHere: "presupuéstalo aquí",
    recommendedUnallocatedRest: " o pasará al próximo periodo.",
    recommendedShortfall: (amount: string) =>
      `Tu revisión de día de pago deja ${amount} para categorías flexibles - el plan está sobrecomprometido, así que aún no hay nada que presupuestar.`,
    spent: "Gastado",
    percentOfBudget: (pct: number) => `${pct}% del presupuesto`,
    noBudget: "sin presupuesto",
    ofBudgeted: (amount: string) => `de ${amount} presupuestado`,
    committed: "Comprometido",
    itemsDueBefore: (count: number, date: string) =>
      `${count} elemento${count === 1 ? "" : "s"} vence${count === 1 ? "" : "n"} antes de ${date}`,
    income: "Ingresos",
    loggedThisPeriod: "recibido para este periodo",
    of: (amount: string) => `de ${amount}`,
    reached: "Alcanzada",
    dueThisPeriod: "vence este periodo",
    periodsTo: (n: number, date: string) => `${n} periodo${n === 1 ? "" : "s"} hasta ${date}`,
    perPayPeriod: "por periodo de pago",
    perPayPeriodByHand: "por periodo de pago a mano",
    savedAhead: (amount: string) => `${amount} con fecha posterior a hoy, fuera de esta cifra`,
    fromRecurring: (amount: string) => `${amount} de aportes recurrentes`,
    planVersusContributed: (period: string, planned: string, contributed: string) =>
      `${period}: ${planned} planificado · ${contributed} aportado`,
    contributedInPeriod: (period: string, contributed: string) => `${period}: ${contributed} aportado`,
    pace: "Promedio hasta ahora",
    perPeriod: "por periodo",
    onTrackFor: (date: string) => `en camino para ${date}`,
    noContributionsYet: "Aún no hay aportes",
    contributionSuffix: " · aporte",
  },
  monthlyPace: {
    title: "Ritmo de gasto mensual",
    projected: "Proyectado este mes",
    average: "Tu promedio",
    dayOfMonth: (elapsed: number, total: number) => `Día ${elapsed} de ${total}`,
    aboveAverage: (amount: string) => `${amount} por encima de tu promedio`,
    belowAverage: (amount: string) => `${amount} por debajo de tu promedio`,
    onPace: "Al ritmo de tu promedio",
    setAside: (amount: string) =>
      `No proyectado: ${amount} gastados hasta ahora en gastos únicos y en la parte de otras personas en gastos compartidos.`,
    lifestyle: "Estilo de vida",
    committed: "Comprometido",
    savings: "Ahorros e inversión",
    totalOutflow: "Salida de efectivo total",
    basedOnMonths: (n: number) =>
      `Basado en ${n === 1 ? "el último mes completado" : `los últimos ${n} meses completados`}`,
    insufficientHistoryTitle: "Los promedios mensuales aparecen después de tres meses completados de actividad",
    insufficientHistoryDescription: (n: number) =>
      n === 0
        ? "Cadence necesita algunos meses de actividad para comparar este mes."
        : `${n} mes${n === 1 ? "" : "es"} completado${n === 1 ? "" : "s"} registrado${n === 1 ? "" : "s"} hasta ahora - sigue registrando para desbloquear la comparación.`,
  },
  transactions: {
    title: "Transacciones",
    recordsSummary: (total: number, out: string, income: string) =>
      `${total} registro${total === 1 ? "" : "s"} · ${out} gastado, ${income} recibido, por fecha de transacción`,
    importCsv: "Importar CSV",
    transfer: "Transferencia",
    new: "Nueva",
    addAccountFirstTitle: "Primero agrega una cuenta",
    needAccountDescription: "Las transacciones pertenecen a una cuenta, así que empieza por ahí.",
    goToAccounts: "Ir a cuentas",
    nothingHereTitle: "Todavía no hay nada aquí",
    noTransactionsDescription: "Las transacciones que agregues o importes aparecerán aquí.",
    noMatchFilters: "Ninguna transacción coincide con estos filtros.",
    noMatchesTitle: "Sin coincidencias",
    clearFilters: "Limpiar filtros",
    pageOf: (page: number, count: number, size: number) =>
      `Página ${page} de ${count} · ${size} por página`,
    previous: "Anterior",
    next: "Siguiente",
    colDate: "Fecha",
    colDescription: "Descripción",
    colAccount: "Cuenta",
    colSource: "Fuente",
    colAmount: "Monto",
    rowActionsAria: "Acciones de la fila",
    transferTo: (name: string) => `Transferencia a ${name}`,
    transferFrom: (name: string) => `Transferencia desde ${name}`,
    anotherAccount: "otra cuenta",
    uncategorized: "Sin categoría",
    deleteTransferTitle: "¿Eliminar esta transferencia?",
    deleteTransferDescription: "Ambos lados de la transferencia se eliminan juntos.",
    deleteTransactionTitle: "¿Eliminar esta transacción?",
    deleteTransactionDescription: "Esto no se puede deshacer.",
    deleteSettlesDropped: (name: string, date: string) =>
      `Este cargo pagó el pago de ${name} del ${date}. Si lo eliminas, ese pago no se publicará otra vez.`,
    deleteSettlesPosts: (name: string, date: string) =>
      `Este cargo está guardado como el pago de ${name} del ${date}. Si lo eliminas, ese pago se publicará en su fecha.`,
    editTransaction: "Editar transacción",
    newTransaction: "Nueva transacción",
    manualDescription: "Registrado manualmente: la fuente queda como Manual.",
    saveChanges: "Guardar cambios",
    addTransaction: "Agregar transacción",
    notePlaceholder: "¿Para qué fue?",
    direction: "Dirección",
    directionOut: "Saliente - el dinero salió de esta cuenta",
    directionIn: "Entrante - el dinero llegó, para reenviarlo",
    editTransfer: "Editar transferencia",
    moveMoney: "Mover dinero",
    transferDescription:
      "Entre tus propias cuentas. Las transferencias nunca cuentan como ingreso ni gasto.",
    recordTransfer: "Registrar transferencia",
    from: "Desde",
    to: "Hacia",
    searchNotes: "Buscar notas",
    allAccounts: "Todas las cuentas",
    allCategories: "Todas las categorías",
    allTypes: "Todos los tipos",
    allSources: "Todas las fuentes",
    accountPlaceholder: "Cuenta",
    categoryPlaceholder: "Categoría",
    typePlaceholder: "Tipo",
    sourcePlaceholder: "Fuente",
    fromDateAria: "Fecha desde",
    toDateAria: "Fecha hasta",
    toSeparator: "a",
    clear: "Limpiar",
    filters: "Filtros",
    filtersActive: (count: number) =>
      `Filtros, ${count} ${count === 1 ? "activo" : "activos"}`,
    applyFilters: "Aplicar",
    removeFilter: (label: string) => `Quitar filtro: ${label}`,
    dateRangeChip: (from: string | undefined, to: string | undefined) =>
      from && to ? `${from} – ${to}` : from ? `Desde ${from}` : `Hasta ${to}`,
    backToTransactions: "Transacciones",
    importCsvTitle: "Importar CSV",
    importCsvDescription:
      "Asigna tres columnas, revisa la vista previa y confirma. Las filas importadas se etiquetan con la fuente CSV.",
    importedNeedAccount: "Las filas importadas necesitan una cuenta donde registrarse.",
    transactionUpdated: "Transacción actualizada",
    transactionAdded: "Transacción agregada",
    transactionDeleted: "Transacción eliminada",
    transferUpdated: "Transferencia actualizada",
    transferRecorded: "Transferencia registrada",
    signSigned: "Con signo: negativo es gasto",
    signExpenses: "Cada fila es un gasto",
    signIncome: "Cada fila es un ingreso",
    step1: "Elige un archivo",
    step2: "Mapea las columnas",
    step3: "Revisa e importa",
    rowsRead: (name: string, count: number) =>
      `${name} · ${count} fila${count === 1 ? "" : "s"} leída${count === 1 ? "" : "s"}`,
    csvHint:
      "Una exportación CSV simple de tu banco. No se escribe nada hasta que revises la vista previa.",
    firstRowHeader: "La primera fila es un encabezado",
    dateColumn: "Columna de fecha",
    amountColumn: "Columna de monto",
    descriptionColumn: "Columna de descripción",
    dateFormat: "Formato de fecha",
    dateFormatHint: "Cómo se escriben las fechas en tu archivo",
    amountConvention: "Convención de montos",
    importInto: "Importar a la cuenta",
    categoryForEveryRow: "Categoría para cada fila",
    noCategory: "Sin categoría",
    column: (n: number) => `Columna ${n}`,
    accountColumn: "Columna de cuenta",
    accountColumnHint:
      "Opcional. Si se indica, solo se importan las filas que nombran la cuenta elegida abajo: para una exportación de Cadence con varias cuentas.",
    categoryColumn: "Columna de categoría",
    categoryColumnHint:
      "Opcional. Una fila cuya celda coincide por nombre con una de tus categorías se archiva ahí; las demás reciben la categoría elegida abajo.",
    noColumn: "Ninguna",
    // Las tres marcas por fila que lleva una exportación de Cadence (ver src/lib/data/export.ts).
    oneOffColumn: "Columna de gasto único",
    oneOffColumnHint:
      "Opcional. Una fila cuya celda dice Sí se importa como gasto único, fuera de los promedios de gasto habitual.",
    oneOffIncomeColumn: "Columna de ingreso único",
    oneOffIncomeColumnHint:
      "Opcional. Una fila de ingreso cuya celda dice Sí se importa como ingreso único, fuera del ingreso que Cadence espera en periodos futuros.",
    yourShareColumn: "Columna de tu parte",
    yourShareColumnHint:
      "Opcional. Una fila de gasto con un monto aquí se importa como gasto compartido, con esa parte como tuya.",
    reimbursesColumn: "Columna de reembolso",
    reimbursesColumnHint:
      "Opcional. Una fila de ingreso que nombra aquí un gasto compartido (fecha · descripción · monto, como lo exporta Cadence) se vincula a ese gasto como devolución.",
    reimbursementsUnresolved: (n: number) =>
      `${n} ${n === 1 ? "devolución no pudo" : "devoluciones no pudieron"} vincularse a un gasto compartido y se ${n === 1 ? "importó" : "importaron"} como ingreso ordinario`,
    otherAccount: "otra cuenta",
    otherAccountSuffix: (n: number) =>
      `${n} pertenece${n === 1 ? "" : "n"} a otra cuenta y no se importará${n === 1 ? "" : "n"}`,
    rowsReady: (count: number) => `${count} fila${count === 1 ? "" : "s"} lista${count === 1 ? "" : "s"}`,
    skippedSuffix: "omitida(s) porque no se pudo leer la fecha o el monto",
    unreadable: "no se pudo leer",
    skipped: "omitida",
    showingFirst: (n: number, total: number) =>
      `Mostrando las primeras ${n} de ${total} filas.`,
    importCount: (n: number) => `Importar ${n} ${n === 1 ? "transacción" : "transacciones"}`,
    imported: (count: number) => `${count} ${count === 1 ? "transacción" : "transacciones"} importada${count === 1 ? "" : "s"}`,
    importLooksRecurring: (count: number) =>
      count === 1
        ? "1 patrón en tus gastos parece recurrente"
        : `${count} patrones en tus gastos parecen recurrentes`,
    reviewOnRecurring: "Revisar",
    invalidDateRow: "Una fila tiene una fecha inválida",
    couldNotReadRows: "No se pudieron leer las filas procesadas",
    accountNoLongerExists: "Esa cuenta ya no existe",
    transactionNoLongerExists: "Esa transacción ya no existe",
    accountNoLongerActive: "Esa cuenta está archivada; elige una activa",
    categoryNoLongerExists: "Esa categoría ya no existe",
    transferNoLongerExists: "Esa transferencia ya no existe",
    editFromTransferForm: "Edita esta transferencia desde el formulario de transferencias",
    editContributionFromGoal:
      "Este gasto es un aporte a una meta: cámbialo desde la página de la meta para que su progreso se mantenga al día",
    editOpeningBalanceFromAccounts:
      "Este es el saldo inicial de una cuenta: cámbialo desde la página de Cuentas para que se mantenga separado de ingresos y gastos",
    editPaycheckFromCheckin:
      "Este es un sueldo registrado por un check-in de día de pago: cámbialo repitiendo el check-in de ese período para que sus cifras se mantengan al día",
    deletePaycheckFromCheckin:
      "Este sueldo lo registró un check-in de día de pago: repite ese check-in con 0 de ingreso para quitarlo, así sus cifras se mantienen al día",
    paycheckLocked: "Registrado por un check-in de día de pago",
    openingBalance: "Saldo inicial",
    externalTransferOut: "Transferencia externa saliente",
    externalTransferIn: "Transferencia externa entrante",
    externalTransferBadge: "Externa",
    nothingToDelete: "Nada que eliminar",
    detectedPatternsTitle: "Patrones detectados",
    detectedPatternsDescription:
      "Comercios repetidos encontrados en este archivo. Acepta una sugerencia, elige otra categoría o deja un grupo sin categorizar - las filas se importan de todos modos.",
    patternRowCount: (n: number) => `${n} ${n === 1 ? "transacción" : "transacciones"}`,
    suggestedCategory: (name: string) => `Sugerido: ${name}`,
    possibleSubscription: "Posible suscripción",
    possibleTransfer: "Posible transferencia",
    acceptCategory: (name: string) => `Aceptar ${name}`,
    chooseCategory: "Elegir categoría",
    leaveUncategorized: "Dejar sin categorizar",
    leaveAsExpense: "Dejar como gasto",
    categorizeAsSubscriptions: "Categorizar como Suscripciones",
    createRecurringItem: "Crear elemento recurrente",
    reviewGroup: "Revisar",
    showRows: (n: number) => `Mostrar ${n} fila${n === 1 ? "" : "s"}`,
    hideRows: "Ocultar filas",
    appliedCategory: (name: string) => `Categorizado como ${name}`,
    appliedUncategorized: "Dejado sin categorizar",
    appliedLeaveAsExpense: "Dejado como gasto normal",
    changeDecision: "Cambiar",
    unknownMerchantsTitle: "Comercios desconocidos",
    reviewIndividually: "Revisar individualmente",
    selectedCount: (n: number) => `${n} seleccionada${n === 1 ? "" : "s"}`,
    selectAllAria: "Seleccionar todo",
    selectRowAria: "Seleccionar fila",
    markAsIncome: "Marcar como ingreso",
    appliedMarkedAsIncome: "Marcado como ingreso",
    recordAsExternalTransfer: "Registrar como transferencia externa",
    appliedExternalTransfer: "Registrado como transferencia externa",
    resolveTransfersHint: (n: number) =>
      `Resuelve ${n} posible${n === 1 ? "" : "s"} transferencia${n === 1 ? "" : "s"} antes de importar`,
    possibleDuplicatesTitle: "Posibles duplicados",
    possibleDuplicatesDescription:
      "Estas filas coinciden con transacciones ya importadas desde un CSV a esta cuenta: misma fecha, monto y descripción. Se omiten a menos que las importes de todos modos.",
    checkingDuplicates: "Buscando filas ya importadas...",
    matchesExisting: (date: string) => `Ya importada, con fecha ${date}`,
    importAnyway: "Importar de todos modos",
    skipDuplicate: "Omitir",
    appliedImportAnyway: "Se importará",
    appliedSkipped: "Omitida",
    duplicatesSkippedHint: (n: number) =>
      `${n} posible${n === 1 ? "" : "s"} duplicado${n === 1 ? "" : "s"} omitido${n === 1 ? "" : "s"}: revísalos arriba para importar alguno`,
    duplicatesNeedReview: (n: number) =>
      `${n} fila${n === 1 ? " coincide" : "s coinciden"} con transacciones ya importadas: revisa primero los posibles duplicados`,
    importCollision: "Algunas de estas filas se importaron hace un momento: revisa el libro e intenta de nuevo",
    // Una fila que el libro ya tiene como fila que Cadence escribió: un cargo
    // recurrente registrado o el sueldo de un check-in (ver
    // src/lib/data/posted-duplicates.ts).
    upcomingDuplicatesDescription:
      "Una fila también puede ser un pago en otra moneda que aún no se ha registrado: se importa de todos modos, y \"Es ese pago\" la guarda como ese pago para que no se cobre otra vez.",
    postedDuplicatesDescription:
      "Algunas filas coinciden con un cargo que Cadence ya registró desde un elemento recurrente, o con un sueldo que registró un check-in, en esta cuenta. Una coincidencia exacta (con el nombre o la categoría del elemento, un sueldo, o el mismo monto a pocos días del cargo registrado) se omite como el cargo registrado a menos que digas que es otro. Una posible coincidencia (en otra moneda, o el mismo monto más lejos, sin el nombre ni la categoría del elemento) se importa a menos que digas que es el cargo registrado.",
    postedMatchRecurring: (name: string, date: string, amount: string) => `Coincide con ${name}, registrado el ${date} por ${amount}`,
    postedMatchPaycheck: (date: string, amount: string) => `Coincide con el sueldo registrado el ${date} por ${amount}`,
    postedMatchOthers: (list: string) => `También podría ser: ${list}`,
    postedMatchPossible: "Posible coincidencia",
    postedMatchUpdates: (from: string, to: string) => `Como cargo registrado, cambia de ${from} a ${to}`,
    postedMatchStaysAsIs: "Como cargo registrado, se queda como está",
    postedMatchOtherAccount: (posted: string, entry: string) => `El cargo registrado está en ${posted}; este está en ${entry}`,
    postedMatchMovesAccount: (from: string, to: string, amount: string) =>
      `Responder "Es el cargo registrado" mueve el cargo registrado de ${from} a ${to}, la cuenta de la que salió el dinero, por ${amount}`,
    postedMatchBothAmounts: (recorded: string, deposit: string) =>
      `Sueldo registrado: ${recorded}. Este depósito: ${deposit}. El sueldo se queda como se registró.`,
    isPostedCharge: "Es el cargo registrado",
    isRecordedPaycheck: "Es el sueldo ya registrado",
    isDifferentCharge: "Es otro cargo",
    appliedPostedCharge: "Se toma como el cargo registrado",
    appliedRecordedPaycheck: "Se toma como el sueldo registrado",
    postedChargesKept: (n: number, updated: number) =>
      `${n} ya en el libro, no se agrega${n === 1 ? "" : "n"} de nuevo${updated ? ` (${updated} monto${updated === 1 ? "" : "s"} registrado${updated === 1 ? "" : "s"} actualizado${updated === 1 ? "" : "s"})` : ""}`,
    postedMatchChanged: "Los cargos registrados cambiaron desde que se revisó este archivo: revisa de nuevo los posibles duplicados",
    postedPromptTitle: "¿Es el cargo registrado?",
    paycheckPromptTitle: "¿Es el sueldo ya registrado?",
    postedPromptDescription: (entered: string, posted: string) =>
      `Tu entrada de ${entered} está guardada. El cargo registrado es de ${posted}. "Es el cargo registrado" quita la entrada que acabas de guardar y conserva el registrado, para contar el dinero una sola vez. Si cierras esto, se quedan ambos.`,
    paycheckPromptDescription: (entered: string, posted: string) =>
      `Tu entrada de ${entered} está guardada. El sueldo que registró el check-in es de ${posted}. "Es el sueldo ya registrado" quita la entrada que acabas de guardar y deja el sueldo como se registró. Si cierras esto, se quedan ambos.`,
    postedChargeKept: "Se conservó el cargo registrado: tu entrada no se sumó dos veces",
    postedChargeKeptUpdated: (from: string, to: string) => `Se conservó el cargo registrado, ahora ${to} (antes ${from})`,
    paycheckKept: "Se conservó el sueldo ya registrado: tu entrada no se sumó dos veces",
    postedMatchGone: "Ese cargo registrado ya no coincide con esta entrada: no cambió nada",
    postedMatchNotApplicable: "Solo una entrada que agregaste a mano, aún sin emparejar, puede tomarse como el cargo registrado",
    postedEntryAlreadyGone: "Esa entrada ya se quitó: no cambió nada más",
    postedEntryChanged: "Esa entrada cambió después de guardarse, así que se conservó: quítala de la lista si es un duplicado",
    postedMatchCheckFailed: "No se pudo revisar el cargo registrado ahora: no cambió nada, tu entrada se conserva",
    // Gastos extraordinarios (únicos) - ver src/lib/extraordinary.ts.
    extraordinaryBadge: "Único",
    markExtraordinary: "Marcar como gasto único",
    unmarkExtraordinary: "No es un gasto único",
    markedExtraordinary: "Marcado como gasto único: queda fuera de los promedios de gasto habitual",
    unmarkedExtraordinary: "Vuelve a contar como gasto normal",
    extraordinaryNotApplicable: "Solo un gasto que registraste o importaste puede marcarse como único",
    extraordinaryPromptTitle: "¿Fue un gasto único?",
    extraordinaryPromptDescription: (amount: string, category: string, typical: string) =>
      `${amount} está muy por encima de lo que sueles gastar en ${category} (normalmente alrededor de ${typical}). Un gasto único sigue contando como gasto, pero queda fuera de los promedios detrás de las sugerencias del día de pago y del ritmo mensual.`,
    extraordinaryYes: "Sí, fue un gasto único",
    extraordinaryNo: "No, gasto normal",
    possibleExtraordinaryTitle: "Inusualmente grandes",
    possibleExtraordinaryDescription:
      "Estas filas están muy por encima de lo que sueles gastar en su categoría. Se importan como gasto normal a menos que las marques como únicas, lo que las deja fuera de los promedios detrás de las sugerencias del día de pago y del ritmo mensual.",
    checkingExtraordinary: "Buscando filas inusualmente grandes...",
    typicalForCategory: (category: string, typical: string) =>
      `${category} · normalmente alrededor de ${typical}`,
    keepAsNormal: "Dejar como normal",
    appliedExtraordinary: "Gasto único",
    appliedNormal: "Gasto normal",
    // Ingreso único (un regalo, una venta, un reembolso) - ver Transaction.isOneOffIncome.
    oneOffIncomeBadge: "Ingreso único",
    oneOffIncomeLabel: "Ingreso único",
    oneOffIncomeHint:
      "Un regalo, una venta, una devolución. Cuenta como ingreso de este periodo, pero Cadence no lo esperará de nuevo en periodos futuros.",
    oneOffIncomeNotApplicable: "Solo un ingreso que registraste o importaste puede marcarse como ingreso único",
    // Gastos compartidos y sus reembolsos - ver src/lib/shared-expense.ts.
    sharedExpenseLabel: "Fue un gasto compartido",
    sharedExpenseHint:
      "Pagaste también por otras personas, que te devolverán su parte. El monto completo sigue saliendo de la cuenta; solo tu parte alimenta los promedios detrás de las sugerencias del día de pago y del ritmo mensual, y la revisión de gasto único.",
    yourShareLabel: (code: string) => `Tu parte (${code})`,
    sharedBadge: "Compartido",
    yourShareOf: (share: string) => `tu parte ${share}`,
    recoveredSoFar: (recovered: string, owed: string, pending: string) =>
      `Recuperado hasta ahora: ${recovered} de ${owed} · ${pending} pendiente`,
    fullyReimbursed: (owed: string) => `Reembolsado por completo: ${owed}`,
    reimbursesLabel: "Reembolsa un gasto compartido",
    reimbursesNone: "No: ingreso ordinario",
    reimbursesOption: (date: string, description: string, pending: string) =>
      `${date} · ${description} · ${pending} pendiente`,
    reimbursesHint:
      "Un depósito vinculado aumenta el saldo de la cuenta como cualquier ingreso, pero nunca se promedia como ingreso.",
    reimbursementOf: (description: string) => `Reembolso: ${description}`,
    sharedNotApplicable: "Solo un gasto que registraste o importaste puede ser un gasto compartido",
    sharedKeptNotice: (share: string) =>
      `Gasto compartido: tu parte ${share}. Un cargo recurrente publicado no puede compartirse ni dejar de compartirse aquí, así que la parte se mantiene tal cual.`,
    sharedHasReimbursements:
      "Todavía hay depósitos vinculados a este gasto compartido: desvincúlalos o elimínalos primero",
    reimbursedExpenseNotShared: "Elige un gasto compartido para reembolsar",
    receivedAmountLabel: (code: string) => `Monto realmente recibido (${code})`,
    receivedAmountHint:
      "Déjalo en blanco para registrar el mismo monto en ambos lados, convertido a la tasa de hoy. Escríbelo para registrar exactamente lo que acreditó el banco.",
    // Montos guardados en la moneda de la cuenta (src/lib/account-money.ts).
    savedAsCharged: (amount: string, rate: string) => `Se guarda en esta cuenta como ${amount}, tal como se cobró (${rate}).`,
    chargedAmountLabel: (currency: string) => `Monto cobrado en ${currency}`,
    accountAmountLabel: (currency: string) => `Monto en ${currency}`,
    chargedAmountHint: "Opcional. La cifra de tu estado de cuenta; se guarda tal cual, conservando el monto de arriba.",
    ratesUnavailableEnterInAccount: (label: string, currency: string) =>
      `Las tasas de cambio no están disponibles ahora, así que este monto no se puede convertir. Ingrésalo en ${currency} en "${label}", o inténtalo más tarde.`,
    savedAsTodaysRate: (amount: string, rate: string) => `Se guarda en esta cuenta como ${amount} (${rate}, tasa de hoy).`,
    savedAsKeptRate: (amount: string, rate: string) =>
      `Se guarda en esta cuenta como ${amount} (${rate}, la tasa con la que se guardó).`,
    enteredAs: (original: string, rate: string) => `registrado como ${original} · ${rate}`,
    // Ingreso apartado para un pago recurrente (src/lib/earmarks.ts).
    earmarkLabel: "Este dinero es para un pago próximo",
    earmarkHint:
      "Elige el pago que cubre. Ese pago le pide entonces esa cantidad menos a tu plan, y el dinero no se cuenta además como ingreso.",
    earmarkPaymentLabel: "Pago",
    earmarkPick: "Elige un pago",
    earmarkOption: (name: string, date: string, stillAsked: string) => `${name} · ${date} · faltan ${stillAsked}`,
    earmarkAmountLabel: (code: string) => `Apartado para él (${code})`,
    earmarkAddAnother: "Agregar otro pago",
    earmarkRemove: "Quitar",
    earmarkNoPayments: "Ningún pago próximo se cobra a esta cuenta.",
    earmarkIssues: {
      amount: "Ingresa un monto mayor que 0 para cada pago",
      duplicate: "Elige cada pago una sola vez",
      target: "Ese pago ya no está abierto en esta cuenta; elige otro",
      over_deposit: "Los montos apartados suman más que este depósito",
      over_occurrence: "Es más de lo que falta por ese pago",
      not_depositable: "Solo un ingreso o dinero que entra de fuera puede apartarse para un pago",
      adopted_paycheck:
        "Este depósito es parte del pago de un chequeo de pago confirmado: el plan ya lo cuenta como ingreso, así que no puede apartarse también para un pago",
    },
    earmarkNotSavedWithDeposit: (reason: string) => `El depósito se guardó, pero no el pago para el que está apartado: ${reason}`,
    // Un cargo registrado antes de publicarse que puede ser un pago próximo en otra moneda.
    postedMatchUpcoming: (name: string, date: string, amount: string) =>
      `Coincide con ${name}, que vence el ${date} por ${amount}, aún sin publicar`,
    upcomingMatchOutcome: "Como ese pago, tu registro queda tal cual y el pago no se publicará otra vez.",
    upcomingPromptTitle: "¿Es un pago próximo?",
    upcomingPromptDescription: (entered: string, scheduled: string) =>
      `Tu registro de ${entered} está guardado. El pago que podría ser es ${scheduled}. "Es ese pago" conserva tu registro como el pago, así no se publica otra vez en su fecha. Cerrar esto conserva ambos.`,
    isUpcomingPayment: "Es ese pago",
    upcomingPaymentsKept: (count: number) =>
      `${count === 1 ? "1 fila guardada como su pago próximo" : `${count} filas guardadas como sus pagos próximos`}; no se registran otra vez`,
    appliedUpcomingPayment: "Importada como ese pago",
    upcomingKept: (name: string) => `Guardado como el pago de ${name}; no se publicará otra vez`,
  },
  accounts: {
    title: "Cuentas",
    acrossAccounts: (net: string, count: number) =>
      `${net} en ${count} cuenta${count === 1 ? "" : "s"}`,
    whereMoneySits: "Dónde está tu dinero.",
    newAccount: "Nueva cuenta",
    noAccountsTitle: "Aún no hay cuentas",
    noAccountsDescription:
      "Agrega las cuentas que realmente usas: corriente, ahorros, efectivo, y todo lo demás se conecta a ellas.",
    addFirstAccount: "Agrega tu primera cuenta",
    colType: "Tipo",
    colActivity: "Actividad",
    colBalance: "Saldo",
    scheduledAfterToday: (amount: string) => `${amount} con fecha posterior a hoy, fuera de este saldo`,
    transactionCount: (n: number) => `${n} ${n === 1 ? "transacción" : "transacciones"}`,
    actionsFor: (name: string) => `Acciones de ${name}`,
    deleteAccountTitle: (name: string) => `¿Eliminar ${name}?`,
    transactionsGoWithIt: (n: number) =>
      `Sus ${n} ${n === 1 ? "transacción" : "transacciones"} se eliminan también, incluidos ambos lados de cualquier transferencia.`,
    noTransactions: "Esta cuenta no tiene transacciones.",
    editAccount: "Editar cuenta",
    newAccountTitle: "Nueva cuenta",
    saveChanges: "Guardar cambios",
    addAccount: "Agregar cuenta",
    namePlaceholder: "Cuenta corriente diaria",
    accountsBreadcrumb: "Cuentas",
    balance: "Saldo",
    incomeIn: "Ingresos",
    spendingOut: "Gastos",
    byTransactionDate: "Por fecha de transacción",
    netTransfers: "Transferencias netas",
    inOut: (inAmount: string, outAmount: string) => `${inAmount} entrada · ${outAmount} salida`,
    netExternal: "Externas netas",
    noActivityTitle: "Aún no hay actividad",
    noActivityDescription:
      "Las transacciones registradas en esta cuenta aparecen aquí con un saldo acumulado.",
    addTransaction: "Agregar una transacción",
    colChange: "Cambio",
    transferTo: (name: string) => `Transferencia a ${name}`,
    transferFrom: (name: string) => `Transferencia desde ${name}`,
    anotherAccount: "otra cuenta",
    transfer: "Transferencia",
    accountUpdated: "Cuenta actualizada",
    currencyLocked:
      "Esta cuenta ya tiene transacciones, así que su moneda no se puede cambiar. Crea una cuenta nueva en la otra moneda.",
    accountAdded: "Cuenta agregada",
    accountDeleted: "Cuenta eliminada",
    accountArchived: "Cuenta archivada",
    accountRestored: "Cuenta restaurada",
    accountNoLongerExists: "Esa cuenta ya no existe",
    archiveAccount: "Archivar cuenta",
    restoreAccount: "Restaurar cuenta",
    archiveAccountTitle: (name: string) => `¿Archivar ${name}?`,
    archiveAccountDescription:
      "Su historial se mantiene intacto donde ya aparece - solo deja de aparecer al elegir una cuenta para algo nuevo.",
    archiveInstead: "Archívala en su lugar - tiene historial financiero que conservar.",
    deletePermanently: "Eliminar permanentemente",
    activeTab: "Activas",
    archivedTab: "Archivadas",
    noArchivedAccountsTitle: "No hay cuentas archivadas",
    noArchivedAccountsDescription:
      "Las cuentas que archives conservan su historial completo y aparecen aquí.",
    archivedBadge: "Archivada",
    setOpeningBalance: "Definir saldo inicial",
    editOpeningBalance: "Editar saldo inicial",
    openingBalanceUnavailable:
      "Solo disponible antes de que esta cuenta tenga otras transacciones.",
    openingBalanceDialogTitle: (name: string) => `Saldo inicial de ${name}`,
    openingBalanceDialogDescription:
      "El monto con el que ya cuenta esta cuenta - no es ingreso y no se contará en presupuestos ni reportes.",
    openingBalanceAmountLabel: "Saldo inicial",
    openingBalanceDateLabel: "A partir de",
    openingBalanceSaved: "Saldo inicial guardado",
    openingBalanceBlocked:
      "Esta cuenta ya tiene otras transacciones, así que su saldo inicial está fijo. Usa \"Corregir saldo inicial\" desde el menú de la cuenta.",
    correctStartingBalance: "Corregir saldo inicial",
    correctStartingBalanceTitle: (name: string) => `Corregir el saldo inicial de ${name}`,
    correctStartingBalanceDescription:
      "Esta cuenta ya tiene transacciones, así que su saldo inicial no se puede editar. Ingresa lo que ya había en la cuenta antes de esas transacciones; se registra como una transferencia externa entrante, que sube el saldo igual que un saldo inicial sin contar como ingreso ni gasto.",
    correctionAmountLabel: (code: string) => `Monto que ya había en la cuenta (${code})`,
    correctionAmountHint: "Se suma al saldo que el libro ya muestra.",
    correctionDateHint: "Normalmente el día anterior a la primera transacción registrada.",
    startingBalanceCorrected: "Saldo inicial corregido",
    startingBalanceNote: "Corrección de saldo inicial",
  },
  budgets: {
    title: "Presupuestos",
    description:
      "Se definen por periodo de pago. El presupuesto general determina lo disponible para gastar; los presupuestos por categoría muestran en qué se va.",
    copyLastPeriod: "Copiar periodo anterior",
    backToNow: "Volver a ahora",
    overallBudget: "Presupuesto general",
    overallBudgetForPeriod: "Presupuesto general de este periodo",
    noOverallSet: (total: string) =>
      `No hay presupuesto general definido. Se usa el total de los presupuestos por categoría (${total}).`,
    unallocatedInRows: (amount: string) =>
      `${amount} del margen de este periodo aún no está en ningún presupuesto; presupuéstalo abajo o pasará al próximo periodo.`,
    clearToRemove: "Vacía el campo para eliminar el presupuesto general.",
    prefilledFromCheckin: (amount: string) =>
      `${amount} viene prellenado de tu revisión de día de pago - no se guarda nada hasta que lo confirmes.`,
    spentOf: (spent: string, total: string) => `${spent} gastado de ${total}`,
    committed: "Comprometido",
    recurringStillToCome: (n: number) =>
      `${n} elemento${n === 1 ? "" : "s"} recurrente${n === 1 ? "" : "s"} por llegar`,
    wontPostLeftOut: (n: number) =>
      n === 1 ? "1 más no se registrará y queda fuera" : `${n} más no se registrarán y quedan fuera`,
    safeToSpend: "Disponible para gastar",
    perDay: (amount: string, days: number) => `${amount} al día durante ${days} día${days === 1 ? "" : "s"}`,
    forWholePeriod: "para todo el periodo",
    colCategory: "Categoría",
    colProgress: "Progreso",
    colSpent: "Gastado",
    colBudget: "Presupuesto",
    noBudget: "sin presupuesto",
    uncategorized: "Sin categoría",
    categoryBudgetAria: (name: string) => `Presupuesto de ${name}`,
    saveAria: (label: string) => `Guardar ${label}`,
    budgetCleared: "Presupuesto eliminado",
    budgetSaved: "Presupuesto guardado",
    saveCollided: "Otro guardado llegó primero. Intenta de nuevo.",
    pickPeriodFirst: "Elige primero un periodo",
    noBudgetToCopy: "El periodo anterior no tiene presupuesto para copiar",
    everyBudgetAlreadyCopied: "Este periodo ya tiene todos los presupuestos del periodo anterior",
    copiedForward: (n: number) =>
      `Se ${n === 1 ? "copió" : "copiaron"} ${n} presupuesto${n === 1 ? "" : "s"}`,
  },
  recurring: {
    title: "Recurrentes",
    description:
      "Todo lo que sale según un calendario, registrado automáticamente en tus cuentas al vencer. El check-in de pago aparta estos elementos antes del presupuesto que propone. Lo disponible para gastar es ese presupuesto menos lo que has gastado: los elementos que vencen no se restan de él, así que un presupuesto definido a mano debe dejarles margen.",
    newItem: "Nuevo elemento",
    subscriptions: "Suscripciones",
    monthlyAcrossActive: (amount: string, count: number) =>
      `${amount} al mes entre ${count} elemento${count === 1 ? "" : "s"} activo${count === 1 ? "" : "s"}`,
    noSubscriptionsTitle: "Sin suscripciones",
    noSubscriptionsDescription: "Agrega las facturas que se repiten para que no te sorprendan a mitad de periodo.",
    recurringContributions: "Aportes recurrentes",
    monthlyGoingInto: (amount: string) => `${amount} al mes destinado a algo`,
    noContributionsTitle: "Sin aportes recurrentes",
    noContributionsDescription:
      "El dinero que aportas según un calendario -una inversión, un ahorro programado- vive aquí.",
    editItem: "Editar elemento recurrente",
    newItemTitle: "Nuevo elemento recurrente",
    itemDescription:
      "Las suscripciones son facturas que salen. Los aportes son dinero que destinas a algo. Ambos se registran automáticamente en su fecha de vencimiento.",
    saveChanges: "Guardar cambios",
    addItem: "Agregar elemento",
    namePlaceholder: "Netflix",
    kind: "Tipo",
    frequency: "Frecuencia",
    nextDue: "Próximo vencimiento",
    nextDueHint: "Cada vencimiento se registra automáticamente al llegar. Si escribes una fecha anterior a hoy, las fechas antes de hoy cuentan como ya pagadas, salvo que elijas registrarlas.",
    pastDateNote: (count: number, first: string, last: string, capped: boolean) =>
      `Al guardar se ${count === 1 ? "registra 1 cobro" : `registran ${count} cobros`} con fecha ${count === 1 ? first : `del ${first} al ${last}`}${capped ? "; el resto sigue en las siguientes ejecuciones" : ""}.`,
    pastDatePaidNote: (count: number, first: string, last: string, next: string, left: number | null) =>
      `${count === 1 ? `El pago con fecha ${first} cuenta como ya pagado y no se registra` : `Los ${count} pagos con fecha del ${first} al ${last} cuentan como ya pagados y no se registran`}. El primer cobro es el ${next}${left === null ? "" : `; ${left === 1 ? "queda 1 pago" : `quedan ${left} pagos`}`}.`,
    postPastLabel: "Registrarlos: no están en mis cuentas",
    postPastHint: "Actívalo solo si estos cobros faltan en tus cuentas; si no, se contarían dos veces.",
    allPaymentsPast:
      "Todos los pagos de este plan tienen fecha anterior a hoy, así que cuentan como ya pagados. No queda nada por registrar: activa registrarlos si faltan en tus cuentas.",
    secondDueDay: "Segundo día de vencimiento",
    secondDueDayHint:
      "El otro día del mes en que se cobra esto. Un día que cae en fin de semana se registra el viernes anterior, igual que Próximo vencimiento.",
    goal: "Meta",
    accountHint: "Cada vencimiento se carga a esta cuenta.",
    paymentsLeftLabel: "Pagos restantes",
    paymentsLeftHint:
      "En blanco significa sin fin. Un número es cuántos cobros faltan, contando el próximo; después se detiene solo.",
    paymentsLeftPlaceholder: "Sin límite",
    goalHint: "Cada vencimiento también registra un aporte a esta meta.",
    noGoalsYet: "Aún no hay metas: crea una en la página de Metas primero.",
    needsAccount: "necesita una cuenta",
    needsGoal: "necesita una meta",
    needsHint: "No se registrará hasta que lo configures. Edita el elemento para corregirlo.",
    nextLabel: "próximo",
    paused: "pausado",
    actionsFor: (name: string) => `Acciones de ${name}`,
    pause: "Pausar",
    resume: "Reanudar",
    deleteItemTitle: (name: string) => `¿Eliminar ${name}?`,
    stopsCounting: "Deja de contar como compromiso y ya no se registra ningún cargo suyo. Lo disponible para gastar no cambia. Las transacciones ya registradas se conservan.",
    itemUpdated: "Elemento recurrente actualizado",
    paymentsMoved: (moves: string) => `El pago ya registrado pasó a la nueva fecha: ${moves}.`,
    paymentMove: (from: string, to: string) => `del ${from} al ${to}`,
    recordedPaymentBlocksEdit: (payment: string, chargeDate: string, dueDate: string) =>
      `No se guardó: el pago ${payment} del ${chargeDate} está registrado como el pago del ${dueDate} de este elemento, y ninguna fecha del nuevo calendario le corresponde. Cambia o elimina ese cargo primero.`,
    itemAdded: "Elemento recurrente agregado",
    itemDeleted: "Elemento recurrente eliminado",
    itemNoLongerExists: "Ese elemento ya no existe",
    accountNoLongerActive: "Esa cuenta ya no está activa",
    categoryNoLongerExists: "Esa categoría ya no existe",
    goalNoLongerExists: "Esa meta ya no existe",
    itemChangedElsewhere:
      "Este elemento cambió en otro lugar mientras el formulario estaba abierto. Ábrelo de nuevo y repite el cambio.",
    itemPaused: "Pausado",
    itemResumed: "Reanudado",
    itemResumedNext: (date: string) => `Reanudado. Próximo cobro: ${date}`,
    finished: "terminado",
    goalReached: "meta alcanzada",
    goalReachedHint: "Su meta ya está completa, así que no se registra. Se reanuda solo si se sube el objetivo de la meta; pausa el elemento para dejar de contarlo.",
    finishedResumeHint: "Terminado: edita los pagos restantes para reiniciarlo",
    markPaidOff: "Marcar como pagado",
    itemPaidOff: "Marcado como pagado",
    finishedCannotResume: "Este plan terminó. Edítalo y define los pagos restantes para iniciarlo de nuevo.",
    notAnInstallmentPlan: "Solo un plan de cuotas con pagos restantes se puede marcar como pagado",
    paymentsLeft: (n: number) => (n === 1 ? "1 pago restante" : `${n} pagos restantes`),
    coveredOn: (date: string, covered: string) => `${date}: ${covered}`,
    roomHeading: "¿Qué cuenta puede con esto?",
    roomDescription: (threshold: string, period: string, periods: number) =>
      `Una suscripción se comprueba cuando un solo cobro llega a ${threshold} o cuando su total mensual lo alcanza. La comprobación funciona como ¿Me alcanza? con una compra: el ingreso de cada cuenta para ${period} se proyecta como ${incomeBasisEs(periods)} (la misma mitad del mes); se restan sus otros elementos recurrentes que vencen entonces, el aporte a metas de ese período (el de un check-in confirmado o, si no hay, un estimado al ritmo actual de cada meta) y su parte de tus categorías fijas esenciales; y se reserva su colchón protegido. Los elementos de dos veces al mes no se comprueban. Que haya margen significa que el margen habitual de la cuenta cubre el cobro, no una garantía para todos los períodos. Esto nunca impide guardar.`,
    roomLowHistory: (periods: number) =>
      `Solo ${comparablePeriodsEs(periods)} de historial de ingresos ${periods === 1 ? "respalda" : "respaldan"} estas cifras, así que tómalas como aproximadas hasta que pasen más períodos de pago.`,
    roomChecking: "Comprobando qué cuenta tiene margen...",
    roomChargesTogether: (count: number, charge: string) =>
      `${count} cobros caen en este período y se comprueban juntos (${charge}).`,
    roomColumnAccount: "Cuenta",
    roomColumnHeadroom: "Sobre su colchón",
    roomBeforeAfter: "antes / después",
    roomFits: "Margen",
    roomShort: "Corto",
    roomSelected: "elegida",
    roomNoHistory: (account: string) =>
      `${account} no recibió ingresos en los períodos comparables, así que solo aplica su colchón mínimo.`,
    roomRecommendMost: (account: string, headroom: string, count: number) =>
      `${count} cuentas conservan su colchón con este cobro. ${account} es la que más margen conserva (${headroom}): la mejor cuenta para pagarlo.`,
    roomRecommendOnly: (account: string, headroom: string) =>
      `${account} es la única cuenta que conserva su colchón con este cobro (le quedan ${headroom}).`,
    roomSelectedFits: (account: string) => `${account}, la cuenta elegida arriba, tiene margen para esto.`,
    roomSelectedShort: (account: string, shortfall: string) =>
      `${account}, la cuenta elegida arriba, quedaría ${shortfall} por debajo de su colchón; considera la cuenta indicada aquí.`,
    roomNone: (period: string) =>
      `Ninguna cuenta puede sostener esto por sí sola: todas terminarían ${period} por debajo de su colchón protegido.`,
    roomNoneSuggestion:
      "Aun así puedes guardarlo tal cual. Para repartir el costo, crea dos suscripciones más pequeñas, una por cuenta: una suscripción siempre se cobra a una sola cuenta.",
    fromAfford: "Desde Cuotas",
    fromAffordDescription: (amount: string, count: number) =>
      `${amount} al mes entre ${count} plan${count === 1 ? "" : "es"} en curso, cada uno revisado contra las proyecciones de hoy`,
    noFromAffordTitle: "Sin compras desde Cuotas",
    noFromAffordDescription:
      "Una compra que confirmes en la página de Cuotas se sigue aquí y se vuelve a revisar contra tus proyecciones a medida que otros compromisos aparecen o desaparecen.",
    openAfford: "Abrir Cuotas",
    stillOnTrack: "Sigue en orden",
    stillOnTrackHint:
      "Revisado hoy: cada pago restante sigue pasando las dos comprobaciones de Cuotas contra las proyecciones actuales.",
    shortBy: (amount: string, period: string) => `Faltan ${amount} en ${period}`,
    shortByAccountHint: (account: string) =>
      `Revisado hoy: ${account} terminaría ese periodo por debajo de su colchón protegido. Solo orientativo: nada se bloquea.`,
    shortByFlexibleHint:
      "Revisado hoy: lo disponible para gasto flexible de ese periodo quedaría en déficit. Solo orientativo: nada se bloquea.",
    suggestionsTitle: "Parecen recurrentes",
    suggestionsDescription: (count: number) =>
      count === 1
        ? "1 patrón en tus gastos manuales e importados por CSV se repite según un calendario pero aún no está registrado. No se agrega nada hasta que lo confirmes."
        : `${count} patrones en tus gastos manuales e importados por CSV se repiten según un calendario pero aún no están registrados. No se agrega nada hasta que lo confirmes.`,
    suggestionCadence: (cadence: string, anchorDays: number[]) => {
      switch (cadence) {
        case "WEEKLY":
          return "Semanal";
        case "BIWEEKLY":
          return "Cada 2 semanas";
        case "SEMI_MONTHLY":
          return `Dos veces al mes, alrededor ${dayOfMonthEs(anchorDays[0])} y ${dayOfMonthEs(anchorDays[1])}`;
        case "YEARLY":
          return `Anual, alrededor ${dayOfMonthEs(anchorDays[0])}`;
        case "MONTHLY":
        default:
          return `Mensual, alrededor ${dayOfMonthEs(anchorDays[0])}`;
      }
    },
    suggestionEvidence: (count: number, first: string, last: string) =>
      `${count} cobros, de ${first} a ${last}`,
    suggestionMayRepeat: (item: string, account: string | null) => `Puede repetir ${item}${account ? ` (${account})` : ""}`,
    addAsRecurring: "Agregar como recurrente",
    dismissSuggestion: "Descartar",
    dismissSuggestionHint: "No volver a sugerir esto",
    showCharges: (count: number) => `Ver ${count} cobros`,
    hideCharges: "Ocultar cobros",
    suggestionAdded: (name: string) => `${name} agregado a tus suscripciones`,
    suggestionDismissed: "Descartado. No se volverá a sugerir.",
    suggestionGone: "Esa sugerencia ya no está. Recarga la página para ver lo actual.",
  },
  afford: {
    title: "¿Me alcanza?",
    description: "Comprueba si una compra pagada en cuotas cabe en los períodos de pago en los que cae.",
    exploratorySubject: "compra",
    purchaseHeading: "La compra",
    purchaseName: "¿Qué vas a comprar?",
    purchaseNamePlaceholder: "Laptop nueva",
    totalAmount: "Precio total",
    installments: "Cuotas",
    installmentsHint: "En cuántos pagos se divide el precio.",
    frequency: "Se paga cada",
    firstPayment: "Primer pago",
    firstPaymentHint: "Los pagos siguientes salen de esta fecha con la frecuencia elegida.",
    account: "Se paga desde",
    accountHint: "Cada cuota se carga a esta cuenta.",
    scheduleHeading: "Calendario de pagos",
    scheduleDescription:
      "Partes iguales, redondeadas al centavo. Cada una se comprueba contra el período de pago en el que cae y se contabiliza exactamente por este monto.",
    paymentLabel: (n: number) => `Pago ${n}`,
    scheduleTotal: "Total de las cuotas",
    scheduleRoundedUnder: (difference: string) =>
      `Redondeado al centavo: ${difference} menos que el precio ingresado.`,
    scheduleRoundedOver: (difference: string) =>
      `Redondeado al centavo: ${difference} más que el precio ingresado.`,
    noScheduleYet: "Ingresa un precio y un número de cuotas para ver el calendario.",
    checkAffordability: "Comprobar si alcanza",
    checking: "Comprobando...",
    resultsStale: "La compra cambió desde este veredicto: vuelve a comprobar antes de registrarla.",
    verdictViable: "Viable",
    verdictNotViable: "No viable",
    viableSummary: (count: number) =>
      count === 1
        ? "El período de pago en el que cae conserva su colchón protegido y no entra en déficit con esta compra."
        : `Los ${count} períodos de pago en los que cae conservan su colchón protegido y no entran en déficit con esta compra.`,
    notViableSummary: (count: number) =>
      count === 1
        ? "1 período de pago se quedaría corto con esta compra."
        : `${count} períodos de pago se quedarían cortos con esta compra.`,
    summaryTitle: "Después de esta compra",
    summaryViable: (left: string, perDay: string, days: number) =>
      `Viable. Después de esta compra aún tendrías unos ${left} para gastar hasta el próximo check-in (unos ${perDay} al día durante ${days} ${days === 1 ? "día" : "días"}).`,
    summaryViableFuture: (period: string, left: string, perDay: string, days: number) =>
      `Viable. En ${period}, después de este pago tendrías unos ${left} para gastar (unos ${perDay} al día durante ${days} ${days === 1 ? "día" : "días"}).`,
    summaryViableOver: (over: string, period: string | null) =>
      period === null
        ? `Viable para el plan, pero con lo que ya gastaste este período te pasarías unos ${over} hasta el próximo check-in.`
        : `Viable para el plan, pero ${period} se pasaría unos ${over} después de este pago.`,
    summaryNotViable: (period: string, short: string, fit: string, payments: number) =>
      `No viable. A ${period} le faltarían ${short}. El ${payments === 1 ? "pago" : "primer pago"} más grande que aún cabría es de ${fit}${payments === 1 ? "" : `, igual en los ${payments}`}.`,
    summaryNotViableNoFit: (period: string, short: string) =>
      `No viable. A ${period} le faltarían ${short}, y no cabría ningún pago: el margen ya se agotó antes de esta compra.`,
    summaryFirstPayment: "Primer pago",
    summaryConverted: (amount: string, converted: string, rate: string) => `${amount} = unos ${converted} a ${rate}`,
    summaryLeftThisPeriod: "Te queda para gastar este período",
    summaryLeftInPeriod: (period: string) => `Te queda para gastar en ${period}`,
    summaryLeftHint: (projected: boolean, spentSoFar: boolean) =>
      `Antes / después. ${projected ? "El margen proyectado del período (aún no hay check-in confirmado para él)" : "El margen que planeó su check-in"}${spentSoFar ? ", menos lo gastado de tus presupuestos hasta ahora." : "."}`,
    summaryOver: (amount: string) => `${amount} de más`,
    summarySpentSoFar: "Gastado hasta ahora",
    summarySplit: (inBudgets: string, noBudget: string) => `Después: ${inBudgets} en tus presupuestos, ${noBudget} sin presupuesto.`,
    summaryPerDay: "Por día",
    summaryPerDayHint: (days: number, future: boolean) =>
      future ? `Antes / después, en sus ${days} ${days === 1 ? "día" : "días"}` : `Antes / después, ${days} ${days === 1 ? "día" : "días"} restantes contando hoy`,
    summaryAccount: (account: string) => `Saldo de ${account}`,
    summaryAccountHint: (payments: number) =>
      `Ahora / después de ${payments === 1 ? "este pago" : `estos ${payments} pagos`}. Incluye tu reserva y supone que no gastas nada más.`,
    summaryAccountBuffer: (amount: string) => `Colchón que se mantiene: ${amount}`,
    summaryTightest: (period: string, amount: string) =>
      `Período más ajustado: ${period}, con ${amount} por encima del colchón después de su pago.`,
    columnPayment: "Pago",
    columnDate: "Fecha",
    columnPeriod: "Período de pago",
    columnAmount: "Monto",
    columnAccountCheck: (account: string) => `${account} por encima de su colchón`,
    columnFlexibleCheck: "Disponible para categorías flexibles",
    columnBeforeAfter: "antes / después",
    columnVerdict: "Veredicto",
    passes: "Alcanza",
    fails: "Corto",
    checkedTogether: (count: number) =>
      `${count} pagos caen en este período y se comprueban juntos.`,
    shortfallHeading: "Dónde se queda corto",
    accountShortfall: (period: string, account: string, amount: string) =>
      `${period}: ${account} terminaría ${amount} por debajo de su colchón protegido.`,
    flexibleShortfall: (period: string, amount: string) =>
      `${period}: al período le faltarían ${amount} para sus categorías flexibles.`,
    projectionHeading: "Cómo se proyectan estas cifras",
    projectionDescription: (
      account: string,
      periods: number | null,
      coverage: "all" | "none" | "some" = "none",
      confirmedPeriods: string[] = [],
    ) =>
      `${coverage === "none" ? "Todavía no existe un check-in de pago para estos períodos. " : coverage === "some" ? `Hay un check-in de pago confirmado para ${confirmedPeriods.join(", ")}, pero no para los demás períodos. ` : ""}${coverage === "none" ? "" : `Para ${confirmedPeriods.join(", ")} las cifras son las que confirmó el check-in (el pago que registraste, el colchón que guardó, su remanente, sus esenciales y su aporte a metas), así que el margen es el mismo "Disponible para categorías flexibles" que muestra el check-in. `}${coverage === "all" ? "En los demás, el ingreso se proyecta como" : "El ingreso se proyecta como"} ${periods === null ? "el promedio de los períodos de pago comparables indicados bajo cada período" : incomeBasisEs(periods)} (la misma mitad del mes), contado en todas las cuentas desde el primer período con ingresos en cualquiera de ellas, así que un pago que pasó de una cuenta a otra no se cuenta en ambas. Si tus ingresos cambiaron (un trabajo nuevo, por ejemplo), "Contar historial de ingresos desde" en Ajustes define dónde empieza ese historial. Los compromisos de ${account} son exactos: cada elemento recurrente activo cargado a esa cuenta que vence en el período, calculado desde su propio calendario, incluida cualquier compra en cuotas ya registrada aquí y, en el período actual, lo que ya se registró además de lo que falta, más lo que un check-in de pago confirmado haya planificado hacia tus metas para ese período.${coverage === "all" ? "" : " Donde todavía no hay un check-in confirmado, un estimado ocupa el lugar de ese aporte a metas: lo que seguirías aportando a cada meta a su ritmo actual, marcado con * y detallado abajo."} El colchón es la misma fórmula que el check-in aplica por cuenta, y las cifras del período suman todas las cuentas activas.`,
    projectionAccountColumns: (account: string) => `${account} (proyectado)`,
    projectionPeriodColumns: "Todas las cuentas (proyectado)",
    projectionIncome: "Ingreso",
    projectionCommitted: "Compromisos",
    projectionBuffer: "Colchón",
    projectionIncomePeriods: (periods: number) => (periods === 1 ? "ingreso: 1 período" : `ingreso: ${periods} períodos`),
    projectionConfirmed: "check-in confirmado",
    confirmedCarryoverLine: (period: string, amount: string) =>
      `${period} también cuenta ${amount} de remanente, como lo hace su check-in.`,
    confirmedCapLine: (period: string, amount: string) =>
      `${period} descuenta ${amount} por cuentas que estaban por debajo de cero antes del pago, como lo hace su check-in.`,
    lowIncomeHistory: (periods: number) =>
      `Solo ${comparablePeriodsEs(periods)} de historial de ingresos ${periods === 1 ? "respalda" : "respaldan"} esta proyección, así que toma su ingreso como aproximado hasta que pasen más períodos de pago.`,
    projectionEssential: "Fijos esenciales",
    noEssentialFixed: "No hay presupuestos fijos esenciales definidos, así que no se asume ninguno en ninguna comprobación.",
    essentialFixedLine: (periods: string[]) =>
      `Las categorías fijas esenciales se restan en ambas comprobaciones, como las resta el check-in de pago: ${periods.join("; ")}. Cada cuenta asume la parte que su ingreso proyectado representa del período.`,
    essentialFixedPeriod: (period: string, amount: string, basis: "budget" | "suggestion" | "none") =>
      basis === "budget"
        ? `${period} ${amount}, los presupuestos ya definidos para él`
        : basis === "suggestion"
          ? `${period} ${amount}, lo que el check-in sugeriría según tus últimos presupuestos o tu gasto promedio`
          : `${period} no se asume nada, porque todavía no se ha presupuestado ni gastado nada en ellas`,
    noHistoryForAccount: (account: string, periods: number) =>
      periods === 0
        ? `Ningún período de pago comparable cae después de tu fecha de "Contar historial de ingresos desde", así que el ingreso proyectado de ${account} es cero y solo aplica el mínimo del colchón.`
        : `${account} no recibió ingresos en los últimos ${comparablePeriodsEs(periods)}, así que su ingreso proyectado es cero y solo aplica el mínimo del colchón.`,
    estimatedInCommitments: "incluye un aporte estimado a metas *",
    estimatedGoalItem: (amount: string, goal: string) => `${amount} hacia ${goal}`,
    estimatedGoalFunding: (period: string, goals: string[]) =>
      `* ${period}: los compromisos incluyen un estimado de ${goals.length > 1 ? `${goals.slice(0, -1).join(", ")} y ${goals[goals.length - 1]}, cada una a su ritmo actual` : `${goals[0]} a su ritmo actual`} - todavía no confirmado por un check-in de pago, así que puede cambiar cuando hagas el check-in de ese período.`,
    recordHeading: "Registrarla",
    recordedNote: (amount: string, frequency: string, count: number, date: string, paid: number) =>
      `Registra una suscripción de ${amount} ${frequency}, ${count} veces a partir del ${date}.${paid > 0 ? (paid === 1 ? " El pago con fecha anterior a hoy cuenta como ya pagado y no se registra ni se contabiliza." : ` Los ${paid} pagos con fecha anterior a hoy cuentan como ya pagados y no se registran ni se contabilizan.`) : ""} Se apaga sola después del último pago y aparece en todo lo que muestra suscripciones: Recurrentes, el check-in de pago, la contabilización y los informes.`,
    acknowledgeLabel:
      "Entiendo que esta compra deja al menos un período de pago por debajo de su colchón protegido o en déficit, y la registro de todos modos.",
    bought: "La compré",
    addLater: "La agrego yo más tarde",
    boughtToast: "Compra registrada como suscripción",
    recordedTitle: (name: string) => `${name} ya es una suscripción recurrente`,
    recordedDescription: "Se contabiliza en cada fecha de pago y se apaga sola después del último.",
    viewRecurring: "Verla en la página Recurrentes",
    noAccountsTitle: "No hay cuentas activas",
    noAccountsDescription:
      "Agrega una cuenta antes de comprobar una compra: cada cuota se carga a una.",
    accountNoLongerActive: "Esa cuenta ya no está activa",
    acknowledgeFirst: "Reconoce el faltante antes de registrar la compra",
    alreadyPaid: "Ya pagado",
    allInstallmentsPaid:
      "Todos los pagos de este plan tienen fecha anterior a hoy, así que cuentan como ya pagados. No queda nada por revisar ni registrar.",
    frequencyAdverb: {
      WEEKLY: "cada semana",
      BIWEEKLY: "cada 2 semanas",
      MONTHLY: "cada mes",
      YEARLY: "cada año",
    } as Record<string, string>,
  },
  goals: {
    title: "Metas",
    description: "En qué estás ahorrando y qué debe aportar cada periodo de pago.",
    newGoal: "Nueva meta",
    noGoalsTitle: "Aún no hay metas",
    noGoalsDescription: "Agrega un monto objetivo, opcionalmente una fecha, y registra aportes a medida que los hagas.",
    createFirstGoal: "Crea tu primera meta",
    reached: "Alcanzada",
    targetDate: (date: string) => `Meta para ${date}`,
    noTargetDate: "Sin fecha límite",
    percentOf: (pct: number, amount: string) => `${pct}% de ${amount}`,
    savedAhead: (amount: string) => `${amount} con fecha posterior a hoy, fuera de esta cifra`,
    fullyFunded: "Totalmente financiada",
    perPayPeriod: "por periodo de pago",
    perPayPeriodByHand: "por periodo de pago a mano",
    fromRecurring: (amount: string) => `${amount} de aportes recurrentes`,
    dueThisPeriod: "vence este periodo",
    periodsLeft: (n: number) => `${n} periodo${n === 1 ? "" : "s"} restante${n === 1 ? "" : "s"}`,
    pace: "Promedio hasta ahora",
    perPeriod: "por periodo",
    onTrackApprox: (date: string) => `en camino para ~${date}`,
    toGo: (amount: string) => `${amount} por alcanzar`,
    goalsBreadcrumb: "Metas",
    logContribution: "Registrar aporte",
    noTargetPaceNote: "Sin fecha límite: el final se proyecta a partir de tu promedio hasta ahora",
    stillToGo: "Falta por alcanzar",
    contributionCount: (n: number) => `${n} aporte${n === 1 ? "" : "s"}`,
    perPayPeriodLabel: "Por periodo de pago",
    perPayPeriodByHandLabel: "Por periodo de pago, a mano",
    periodsToTarget: (n: number) => `${n} periodo${n === 1 ? "" : "s"} hasta la fecha límite`,
    doneAround: (date: string) => `a este promedio, listo alrededor de ${date}`,
    logToSetPace: "registra un aporte para ver un promedio",
    inCurrency: (code: string) => `En ${code}`,
    ofAmount: (amount: string) => `de ${amount}`,
    driftedWarning: (amount: string) =>
      `El progreso guardado no coincide con el historial de aportes (${amount}). Recalcula desde Ajustes.`,
    contributionHistory: "Historial de aportes",
    noContributionsYetTitle: "Aún no hay aportes",
    noContributionsYetDescription: "Cada monto que registras aquí es la fuente de verdad del progreso de esta meta.",
    removeContributionAria: "Eliminar aporte",
    editGoal: "Editar meta",
    goalDialogDescription: "Una fecha límite convierte la meta en un número por periodo de pago.",
    saveChanges: "Guardar cambios",
    createGoal: "Crear meta",
    namePlaceholder: "Fondo de emergencia",
    targetAmount: "Monto objetivo",
    targetDateLabel: "Fecha límite",
    targetDateHint: "Opcional. Sin ella, Cadence proyecta a partir de tu promedio hasta ahora.",
    actionsFor: (name: string) => `Acciones de ${name}`,
    deleteGoalTitle: (name: string) => `¿Eliminar ${name}?`,
    goalAndHistoryRemoved:
      "Se eliminan la meta y su historial de aportes. Los gastos que esos aportes registraron se quedan en el libro como transacciones normales que puedes editar o eliminar.",
    historyGoesWithIt:
      "Su historial de aportes se elimina también. Los gastos que esos aportes registraron se quedan en el libro como transacciones normales que puedes editar o eliminar.",
    removeContributionTitle: "¿Eliminar este aporte?",
    comesOffProgress: (amount: string) => `${amount} se resta del progreso de la meta.`,
    addTo: (name: string) => `Agregar a ${name}`,
    contributionDialogDescription: "Los aportes son la fuente de verdad del progreso de la meta.",
    amountWithCurrency: (code: string) => `Monto (${code})`,
    contributionAccountHint: "El dinero sale de esta cuenta como un gasto, convertido a su moneda si es diferente.",
    goalUpdated: "Meta actualizada",
    currencyLocked:
      "Esta meta ya tiene aportes, así que su moneda no se puede cambiar. Crea una meta nueva en la otra moneda.",
    goalCreated: "Meta creada",
    goalDeleted: "Meta eliminada",
    goalNoLongerExists: "Esa meta ya no existe",
    contributionLogged: "Aporte registrado",
    contributionCountsAsAutomatic: (date: string) => `Esto contará como el aporte automático que vence el ${date}.`,
    contributionLoggedCountsAsAutomatic: (date: string) => `Aporte registrado. Esto contará como el aporte automático que vence el ${date}.`,
    planVersusContributed: (period: string, planned: string, contributed: string) =>
      `${period}: ${planned} planificado · ${contributed} aportado`,
    contributedInPeriod: (period: string, contributed: string) => `${period}: ${contributed} aportado`,
    plannedBehindRoadmap: (amount: string) => `${amount} por detrás de la hoja de ruta`,
    plannedBehindRemaining: (amount: string) => `${amount} del saldo restante sin planificar`,
    notYetContributed: (amount: string, period: string) => `${amount} planificado para ${period} aún sin aportar`,
    roomShortfallThisPeriod: (amount: string, period: string) =>
      `${amount} del monto de la hoja de ruta de ${period} no se pudo cubrir con lo que les sobraba a las cuentas tras sus suscripciones y colchón al confirmar el plan.`,
    roomShortfallRemainingThisPeriod: (amount: string, period: string) =>
      `${amount} del saldo restante no se pudo cubrir en ${period} con lo que les sobraba a las cuentas tras sus suscripciones y colchón al confirmar el plan.`,
    contributionRemoved: "Aporte eliminado",
    contributionNoLongerExists: "Ese aporte ya no existe",
    editContributionAria: "Editar aporte",
    editContributionTitle: "Corregir este aporte",
    editContributionDescription:
      "Registrado automáticamente por un elemento recurrente. Cambiar el monto aquí también actualiza el gasto que escribió en el libro. El monto del elemento para fechas futuras no cambia.",
    contributionUpdated: "Aporte actualizado",
    contributionNotRecurring: "Aquí solo se corrigen aportes registrados por un elemento recurrente; uno manual se elimina y se registra de nuevo",
    editManualContributionDescription:
      "Cambiar la cuenta mueve el gasto que escribió en el libro y convierte el monto a la moneda de esa cuenta.",
    contributionNotManual: "Aquí solo se corrigen aportes registrados a mano",
    isDebtLabel: "Esta meta es una deuda",
    isDebtHint: "La marca para la comparación de pago de deudas en la página de Metas. Nada más cambia en la meta.",
    debtBadge: "Deuda",
    debtComparatorTitle: "Pagar las deudas: dos órdenes",
    debtComparatorSubject: "comparación de pago de deudas",
    debtComparatorDescription:
      "Cada deuda sigue recibiendo su propio ritmo: lo que su hoja de ruta pide a cada periodo de pago, aportes recurrentes incluidos, menos lo que ya entró en este periodo. Todo extra que agregues va íntegro a la siguiente deuda de cada orden, y cuando una deuda queda saldada su ritmo se suma al extra a partir del periodo siguiente.",
    extraPerPeriodLabel: (code: string) => `Extra por periodo de pago (${code})`,
    debtFlowPerPeriod: (amount: string) => `${amount} llega a estas deudas cada periodo de pago: sus ritmos más el extra.`,
    debtFreeAfter: (n: number, date: string) =>
      `Todas las deudas saldadas tras ${n} periodo${n === 1 ? "" : "s"} de pago en cualquiera de los dos órdenes, para el ${date}.`,
    debtNothingFlowing:
      "Todavía nada llega a estas deudas: ninguna tiene fecha límite, así que ninguna tiene ritmo propio, y no hay extra.",
    debtBeyondHorizon: (n: number) => `A este ritmo las deudas no se saldan en ${n} periodos de pago.`,
    debtSameTotalNote:
      "La cantidad de periodos es la misma en ambos órdenes: el mismo dinero llega a las deudas cada periodo, caiga primero en la deuda que caiga. Lo que cambia es qué deuda termina cuándo.",
    avalancheTitle: "Mayor saldo primero",
    avalancheSubtitle: "Avalancha: el extra va a la deuda con mayor saldo restante.",
    snowballTitle: "Menor saldo primero",
    snowballSubtitle: "Bola de nieve: el extra va a la deuda con menor saldo restante.",
    debtPace: (amount: string) => `${amount} por periodo de pago por sí sola`,
    debtNoPace: "Sin fecha límite: sin ritmo propio",
    debtPaidOffIn: (n: number, date: string) => `Saldada en el periodo ${n} · ${date}`,
    debtNotWithinHorizon: (n: number) => `No se salda en ${n} periodos de pago`,
  },
  reports: {
    title: "Informes",
    description: (code: string) => `Todo en ${code}, convertido a las tasas actuales.`,
    spendingByCategory: "Gastos por categoría",
    nothingSpentTitle: "Nada gastado este periodo",
    nothingSpentDescription: "Los gastos categorizados aparecen aquí en cuanto los registras.",
    lastNPeriods: (n: number) => `Últimos ${n} periodos de pago`,
    averagePerPeriod: (amount: string, n: number) =>
      `${amount} de promedio en ${n} periodo${n === 1 ? "" : "s"} completado${n === 1 ? "" : "s"}`,
    periodSoFar: "hasta ahora",
    peakPeriod: "periodo pico",
    thisPeriod: "Este periodo",
    categoriesTouched: (n: number) => `${n} categoría${n === 1 ? "" : "s"} usada${n === 1 ? "" : "s"}`,
    acrossNPeriods: (n: number) => `En ${n} periodos`,
    incomeThisPeriod: "Ingresos este periodo",
    tooltipOut: (amount: string) => `${amount} gastado`,
    tooltipIn: (amount: string) => `${amount} recibido`,
    monthlySectionTitle: "Gasto mensual",
    monthlySectionDescription:
      "Meses calendario, no periodos de pago: una vista de más largo alcance junto a los periodos de arriba.",
    monthlyTrendTitle: (n: number) =>
      `${n === 1 ? "El último mes completado" : `Los últimos ${n} meses completados`}`,
    monthlyAverageSummary: (amount: string, n: number) =>
      `${amount} de promedio de gasto normal en ${n} mes${n === 1 ? "" : "es"}`,
    monthlyPeakLabel: "mes pico",
    monthlyTooltipNormal: (amount: string) => `${amount} gasto normal`,
    monthlyTooltipSavings: (amount: string) => `${amount} ahorros e inversión`,
    monthlyCategoryBreakdown: "Promedio mensual de gasto de estilo de vida por categoría",
    monthlyCommittedAverage: "Promedio mensual de gasto comprometido",
    monthlyCommittedHint:
      "Suscripciones activas: cargos reales cuando Cadence puede identificarlos, su monto programado en caso contrario.",
    monthlySavingsAverage: "Promedio mensual de ahorros e inversión",
    monthlySavingsHint:
      "Aportes a metas, aportes recurrentes y gastos de Ahorro/Inversión: se mantienen aparte del gasto normal.",
    monthlyTotalOutflowAverage: "Promedio de salida de efectivo total",
    monthlyNormalSpendingNote:
      "El gasto normal es solo estilo de vida más gasto comprometido. Los ahorros y las inversiones no están incluidos.",
    monthlyInsufficientTitle:
      "Los promedios mensuales aparecen después de tres meses completados de actividad",
    monthlyInsufficientDescription: (n: number) =>
      n === 0
        ? "Registra algunos meses de transacciones y aquí aparecerá una vista mensual."
        : `${n} mes${n === 1 ? "" : "es"} completado${n === 1 ? "" : "s"} registrado${n === 1 ? "" : "s"} hasta ahora.`,
  },
  settingsPage: {
    title: "Ajustes",
    description: "Un libro contable de un solo usuario: un PIN, una moneda de visualización, un conjunto de reglas.",
    displayCurrencyTitle: "Moneda de visualización",
    displayCurrencyDescription: "Toda cifra en la app se convierte a esta moneda.",
    languageThemeTitle: "Idioma y tema",
    languageThemeDescription: "En pantallas más anchas están en el encabezado.",
    themeLabel: "Tema",
    exchangeRates: "Tasas de cambio",
    exchangeRatesDescription: "Basadas en USD, cacheadas por 24 horas; las tasas cruzadas se derivan a través de USD.",
    usdTo: (code: string) => `USD a ${code}`,
    lastFetched: (datetime: string) => `Última actualización ${datetime}`,
    noRatesFetched: "Aún no se han obtenido tasas",
    rateServiceUnreachable: " · el servicio de tasas no estaba disponible; se usan los últimos valores conocidos",
    rateSourceBpd: (date: string) => `de Banco Popular (${date})`,
    rateSourceOpenErApi: "de open.er-api.com (tasa de mercado)",
    goalProgress: "Progreso de metas",
    goalProgressDescription:
      "Los totales de las metas se cachean por velocidad. Los aportes son la fuente de verdad: reconstruye la caché a partir de ellos si algo se ve mal.",
    recalculateGoalTotals: "Recalcular totales de metas",
    categorizeHistory: "Categorización de transacciones",
    categorizeHistoryDescription:
      "Las importaciones anteriores a la categorización automática pueden seguir sin categoría. Aplica ahora las mismas reglas de comercio - las transacciones categorizadas manualmente nunca se modifican.",
    categorizeHistoryAction: "Categorizar gastos sin categoría",
    emailConnections: "Conexiones de correo",
    emailConnectionsDescription:
      "Cuentas de Gmail y Outlook desde las que Cadence extrae correos transaccionales, puestas en /review antes de convertirse en transacciones.",
    manageConnections: "Administrar conexiones",
    session: "Sesión",
    sessionDescription: (tz: string, currencies: string) =>
      `Los periodos de pago se resuelven en ${tz}. Monedas disponibles: ${currencies}.`,
    lockCadence: "Bloquear Cadence",
    connectionsTitle: "Conexiones",
    connectionsDescription: "Cuentas de Gmail y Outlook desde las que Cadence extrae correos transaccionales.",
    syncNow: "Sincronizar ahora",
    reviewQueue: "Cola de revisión",
    connectedTo: (x: string) => `Conectado ${x}.`,
    gmailDescription: "Lee recibos, facturas y correos de suscripción (gmail.readonly).",
    outlookDescription: "Lee los mismos tipos de correos vía Microsoft Graph (Mail.Read).",
    neverSynced: "Nunca sincronizado",
    lastSynced: (datetime: string) => `Última sincronización ${datetime}`,
    noAccountConnected: "Aún no hay ninguna cuenta conectada.",
    disconnectTitle: (email: string) => `¿Desconectar ${email}?`,
    disconnectDescription:
      "Cadence deja de sincronizar este correo. Las transacciones ya puestas en revisión o aprobadas desde él se conservan.",
    disconnect: "Desconectar",
    connectAccount: (label: string) => `Conectar cuenta de ${label}`,
    goalsRecalculated: (count: number) =>
      `Se ${count === 1 ? "recalculó" : "recalcularon"} ${count} meta${count === 1 ? "" : "s"}`,
    categorizationBackfilled: (count: number) =>
      count === 0
        ? "Ningún gasto sin categoría coincidió con una regla"
        : `Se ${count === 1 ? "categorizó" : "categorizaron"} ${count} transacción${count === 1 ? "" : "es"}`,
    showingIn: (code: string) => `Mostrando montos en ${code}`,
    nothingToDisconnect: "Nada que desconectar",
    connectionNoLongerExists: "Esa conexión ya no existe",
    disconnected: (email: string) => `${email} desconectado`,
    connectFirst: "Conecta primero una cuenta de Gmail o Outlook",
    syncedResult: (accounts: number, staged: number, accountsFailed = 0, messagesFailed = 0) =>
      `Se ${accounts === 1 ? "sincronizó" : "sincronizaron"} ${accounts} cuenta${accounts === 1 ? "" : "s"} - ${staged} elemento${staged === 1 ? "" : "s"} nuevo${staged === 1 ? "" : "s"} en revisión` +
      (accountsFailed > 0
        ? `. ${accountsFailed} cuenta${accountsFailed === 1 ? " no se pudo" : "s no se pudieron"} sincronizar`
        : "") +
      (messagesFailed > 0
        ? `. ${messagesFailed} correo${messagesFailed === 1 ? " no se pudo leer y se reintentará" : "s no se pudieron leer y se reintentarán"} en la próxima sincronización`
        : "") +
      (accountsFailed > 0 || messagesFailed > 0 ? "." : ""),
    planningPreferencesTitle: "Preferencias de planificación",
    planningPreferencesDescription:
      "Cómo el planificador de pago calcula tu colchón protegido y traslada dinero de un periodo a otro.",
    bufferPercentLabel: "Porcentaje de colchón",
    bufferPercentHint: "Porcentaje del ingreso de cada chequeo reservado como colchón por defecto.",
    bufferFloorLabel: "Colchón mínimo fijo",
    bufferFloorHint:
      "El colchón mínimo que se reserva por cada cuenta que recibe ingresos en un chequeo, así que dos cuentas con ingresos reservan dos mínimos. En cada cuenta rige el mayor entre este monto y el porcentaje.",
    carryoverDefaultLabel: "Incluir remanente por defecto",
    carryoverDefaultHint:
      "Si está activo, el dinero sin gastar del presupuesto del periodo anterior se precarga como remanente incluido en cada chequeo nuevo.",
    historyStartLabel: "Contar historial desde",
    historyStartHint:
      "Si tu situación cambió (un trabajo nuevo, una mudanza, un nuevo hogar), define esta fecha para que los promedios de Cadence lean solo lo que vino después: la proyección de ingresos de Cuotas, las sugerencias por categoría del chequeo de pago, el promedio por periodo de pago de Informes y el ritmo y los promedios de gasto mensual. El historial cuenta desde el primer periodo de pago que empieza en esta fecha o después, y las cifras mensuales desde el primer mes que lo hace. Déjala en blanco para usar todo tu historial.",
    planningPreferencesSaved: "Preferencias de planificación guardadas",
    essentialCategoriesTitle: "Categorías fijas esenciales",
    essentialCategoriesDescription:
      "Las categorías marcadas como fijas esenciales se reservan en el plan de pago antes de las sugerencias de categorías flexibles.",
    noEligibleCategories: "No hay categorías de gasto disponibles para configurar.",
    essentialToggleAria: (name: string) => `Marcar ${name} como fija esencial`,
    categoryNoLongerExists: "Esa categoría ya no existe",
    categoryMarkedEssential: "Marcada como fija esencial",
    categoryUnmarkedEssential: "Ya no es fija esencial",
    categoriesTitle: "Categorías",
    categoriesDescription:
      "Agrega, renombra o cambia el color de las categorías donde se archivan transacciones, elementos recurrentes y presupuestos, y elimina las que no uses.",
    manageCategories: "Administrar categorías",
    categoriesPageDescription:
      "Cada transacción, elemento recurrente y presupuesto por categoría se archiva en una de estas. Eliminar una categoría en uso primero mueve sus filas a otra, así nada queda sin categoría por accidente.",
    newCategory: "Nueva categoría",
    editCategory: "Editar categoría",
    addCategory: "Agregar categoría",
    saveCategory: "Guardar cambios",
    categoryNamePlaceholder: "Mascotas",
    categoryKind: "Tipo",
    categoryColor: "Color",
    renameHint:
      "Las reglas de importación CSV buscan las categorías por nombre, así que renombrar una cambia dónde caen esas importaciones.",
    kindLockedHint: (n: number) =>
      `El tipo no puede cambiar mientras ${n} transacci${n === 1 ? "ón está" : "ones están"} archivada${n === 1 ? "" : "s"} aquí.`,
    usageTransactions: (n: number) => `${n} transacci${n === 1 ? "ón" : "ones"}`,
    usageRecurringItems: (n: number) => `${n} elemento${n === 1 ? "" : "s"} recurrente${n === 1 ? "" : "s"}`,
    usageBudgets: (n: number) => `${n} presupuesto${n === 1 ? "" : "s"} de período`,
    inUse: "En uso",
    notInUse: "Sin uso",
    protectedBadge: "Protegida",
    protectedSubscriptionHint: (name: string) =>
      `${name} no se puede eliminar: lo disponible para gastar y el presupuesto del período tratan su gasto como dinero que el plan de pago ya apartó.`,
    protectedSavingsHint: (name: string) =>
      `${name} no se puede eliminar: el ritmo mensual archiva el ahorro aquí, y cada aporte a meta registrado a mano cae aquí.`,
    categoryActionsFor: (name: string) => `Acciones de ${name}`,
    deleteCategoryTitle: (name: string) => `¿Eliminar ${name}?`,
    deleteCategoryUnused: "No hay nada archivado aquí, así que se elimina de inmediato.",
    removeCategory: "Eliminar",
    reassignTitle: (name: string) => `Mover lo archivado en ${name}`,
    reassignDescription:
      "Estas filas todavía apuntan a ella. Elige a dónde van; la categoría se elimina una vez movidas.",
    willMove: "se mueven",
    willBeCleared: "se borran",
    budgetsMergedHint: "Cada presupuesto se suma al de la categoría a la que muevas, del mismo período.",
    moveTo: "Mover a",
    moveAndRemove: "Mover y eliminar",
    categoryCreated: (name: string) => `${name} agregada`,
    categoryUpdated: (name: string) => `${name} actualizada`,
    categoryDeleted: (name: string) => `${name} eliminada`,
    categoryReassigned: (name: string, rows: number, budgets: number) =>
      `${rows} fila${rows === 1 ? "" : "s"} movida${rows === 1 ? "" : "s"}${
        budgets > 0 ? `, ${budgets} presupuesto${budgets === 1 ? "" : "s"} sumado${budgets === 1 ? "" : "s"}` : ""
      } y ${name} eliminada`,
    categoryNameTaken: "Ya existe una categoría con ese nombre",
    categoryKindInUse: (n: number) =>
      `El tipo no puede cambiar mientras ${n} transacci${n === 1 ? "ón está" : "ones están"} archivada${n === 1 ? "" : "s"} en esta categoría`,
    categoryInUse: "Esa categoría todavía tiene filas archivadas: muévelas primero",
    categoryTargetNoLongerExists: "La categoría de destino ya no existe",
    exportTitle: "Exportar datos",
    exportDescription:
      "Descarga todo lo que Cadence registra como un ZIP de archivos CSV: uno por tipo de dato, abribles en cualquier hoja de cálculo. transactions.csv está en el formato que lee el importador CSV, así que puede volver a importarse; el resto son respaldos completos.",
    exportAll: "Exportar todo",
    categorySameTarget: "Elige una categoría distinta a la que moverlas",
    categoryKindMismatch: "Elige una categoría del mismo tipo a la que moverlas",
    pinTitle: "PIN",
    pinDescription:
      "Cambia el PIN que desbloquea Cadence. Si lo olvidas, la pantalla de desbloqueo ofrece recuperación cuando RECOVERY_SECRET está configurado en el entorno del servidor.",
    currentPin: "PIN actual",
    newPin: "PIN nuevo",
    confirmNewPin: "Confirmar PIN nuevo",
    changePin: "Cambiar PIN",
    pinChanged: "PIN cambiado",
    currentPinWrong: "Ese no es el PIN actual",
  },
  review: {
    title: "Cola de revisión",
    pendingItems: (n: number) => `${n} elemento${n === 1 ? "" : "s"} pendiente${n === 1 ? "" : "s"} de las bandejas conectadas.`,
    hideReviewed: "Ocultar revisados",
    showReviewed: "Mostrar revisados",
    addAccountFirstTitle: "Primero agrega una cuenta",
    needAccountDescription: "Aprobar un elemento en revisión necesita dónde registrarse.",
    goToAccounts: "Ir a cuentas",
    nothingToReviewTitle: "Nada para revisar",
    noStagedYet: "Aún no hay elementos en revisión: conecta una bandeja y sincroniza para empezar.",
    noPendingItems: 'No hay elementos pendientes. Los aprobados y rechazados quedan ocultos: usa "Mostrar revisados" para verlos.',
    manageConnections: "Administrar conexiones",
    colAmount: "Monto",
    colAccount: "Cuenta",
    colCategory: "Categoría",
    colActions: "Acciones",
    approved: "Aprobado",
    rejected: "Rechazado",
    pickAccountFirst: "Elige una cuenta antes de aprobar",
    editAria: "Editar",
    reject: "Rechazar",
    approve: "Aprobar",
    approvedToast: "Aprobado",
    rejectedToast: "Rechazado",
    pickAnAccount: "Elige una cuenta",
    noCategory: "Sin categoría",
    editStagedTitle: "Editar elemento en revisión",
    editStagedDescription: "Los cambios se guardan pero quedan pendientes hasta que apruebes.",
    stagedSaved: "Guardado",
    itemNoLongerExists: "Ese elemento ya no existe",
    alreadyReviewed: "Este elemento ya fue revisado",
    accountNoLongerExists: "Esa cuenta ya no existe",
    accountNoLongerActive: "Esa cuenta está archivada; elige una activa",
    transactionAlreadyExists: "Esta transacción ya existe",
    nothingToReject: "Nada que rechazar",
    postedMatchNeedsChoice: "Esto coincide con un cargo que ya está en el libro: indica si es el cargo registrado u otro",
    keptAsPosted: "Se conservó el cargo registrado: el recibo no se sumó dos veces",
    keptAsPostedUpdated: (from: string, to: string) => `Se conservó el cargo registrado, ahora ${to} (antes ${from})`,
  },
  inbox: {
    title: "Bandeja",
    description:
      "Todo lo que Cadence ha notado y sigue esperando por ti, de cada parte de la app en un solo lugar. Cada elemento también sigue donde apareció hasta que se resuelva.",
    pendingCount: (count: number) =>
      count === 1 ? "1 elemento por revisar" : `${count} elementos por revisar`,
    emptyTitle: "Nada por revisar",
    emptyDescription:
      "Los recurrentes se están registrando, tus planes de Cuotas siguen encajando, no apareció ningún patrón sin seguimiento, cada plan de meta va según su hoja de ruta, ninguna meta se queda corta de lo que su plan apartó al cerrar un periodo y cada meta tiene margen por delante hasta su fecha objetivo.",
    emptyDescriptionDismissed: (count: number) =>
      count === 1
        ? "No hay nada más pendiente. 1 elemento que descartaste está oculto aquí; sigue donde se originó hasta que se resuelva."
        : `No hay nada más pendiente. ${count} elementos que descartaste están ocultos aquí; cada uno sigue donde se originó hasta que se resuelva.`,
    severityCritical: "Requiere atención",
    severityAdvisory: "Orientativo",
    severityCriticalHint: "Dinero ya comprometido no está donde el plan dice.",
    severityAdvisoryHint: "Vale la pena mirarlo; nada se bloquea ni cambia por ello.",
    sourceNotPosting: "Recurrentes",
    sourceAffordViability: "Cuotas",
    sourceRecurringSuggestion: "Parecen recurrentes",
    sourceGoalBehind: "Metas",
    sourceGoalForecast: "Pronóstico de meta",
    dismiss: "Descartar",
    dismissHint: "Quitar de la bandeja. Un problema distinto o posterior aparecerá igualmente. Donde apareció no cambia.",
    dismissed: "Descartado. Un problema distinto o posterior aparecerá igualmente en la bandeja.",
    dismissUnknown: "Ese elemento ya no está en la bandeja",
    openRecurring: "Arreglar en la página de recurrentes",
    openRecurringPage: "Abrir la página de recurrentes",
    openFromAfford: "Verlo en la página de recurrentes",
    openSuggestion: "Revisar en la página de recurrentes",
    openGoal: "Abrir la meta",
    notPostingTitle: (name: string) => `${name} no se está registrando`,
    notPostingReason: "Motivo",
    notPostingDue: "Sigue pendiente",
    notPostingKind: "Tipo",
    notPostingKindSubscription: "Suscripción",
    notPostingKindContribution: "Aporte a meta",
    postingRunFailedTitle: "La última ejecución de registro de recurrentes falló",
    postingRunFailedEffect: "Efecto",
    postingRunFailedEffectValue: "Los elementos recurrentes no se están registrando hasta que una ejecución se complete con éxito.",
    affordTitle: (name: string) => `${name} desde Cuotas ya no encaja`,
    affordShortfall: "Faltan",
    affordPeriod: "En",
    affordCheck: "Revisión que falla",
    affordCheckAccount: (account: string) => `${account} terminaría el periodo por debajo de su colchón`,
    affordCheckFlexible: "Lo disponible para categorías flexibles quedaría en déficit",
    affordHeadroom: "Margen que queda después",
    affordInstallment: "Cuota que vence ahí",
    suggestionTitle: (name: string) => `${name} parece recurrente`,
    suggestionAmount: "Último cobro",
    suggestionCadence: "Cadencia",
    suggestionCharges: "Cobros",
    suggestionChargesValue: (count: number, first: string, last: string) =>
      `${count}, del ${first} al ${last}`,
    suggestionAccount: "Cuenta",
    suggestionNext: "Próximo esperado",
    goalTitle: (name: string) => `El plan para ${name} va por detrás de su hoja de ruta`,
    goalFollowThroughTitle: (name: string) => `${name}: planificado pero aún sin aportar`,
    goalBehindBy: "Por detrás",
    goalRoadmap: "Hoja de ruta, a mano",
    goalPlanned: "Planificado",
    goalNotContributed: "Aún sin aportar",
    goalScheduled: "Aportes recurrentes",
    goalContributed: "Aportado",
    goalPeriod: "Periodo",
    goalTarget: "Fecha objetivo",
    goalRoomShortfall: "El margen no pudo cubrir",
    forecastTitle: (name: string) => `${name} corre riesgo antes de su fecha objetivo`,
    forecastShortfall: "Faltan",
    forecastPeriod: "En",
    forecastPace: "Ritmo de la hoja de ruta",
    forecastScheduled: "Aportes recurrentes",
    forecastRoom: "El margen podría dar",
    forecastRoomOn: (account: string) => `Margen en ${account}`,
    forecastAccounts: "Cuentas con margen",
    forecastNoRoom: "ninguna",
    forecastTarget: "Fecha objetivo",
  },
  payday: {
    bannerTitle: "Chequeo de pago listo",
    bannerDescription:
      "Confirma saldos, registra el ingreso de este periodo y planifica hasta tu próximo pago.",
    startCheckin: "Iniciar chequeo de pago",
    planThisPeriod: "Planificar este periodo",
    checkInForPeriod: "Hacer el check-in de este periodo",
    dismissForToday: "Ahora no",
    reviewConfirmedPlan: "Revisar el plan de este periodo",
    wizardName: "Chequeo de pago",
    wizardTitle: (periodLabel: string) => `Chequeo de pago - ${periodLabel}`,
    stepOf: (step: number, total: number) => `Paso ${step} de ${total}`,
    back: "Atrás",
    next: "Siguiente",
    cancel: "Cancelar",

    step1Title: "Confirma los saldos de las cuentas",
    step1Description:
      "Esto es solo una verificación de conciliación - nunca crea ingresos ni gastos.",
    step1BalanceMeaning:
      "El “saldo reportado” es lo que la cuenta tenía el día antes de que llegara el pago de este periodo - no lo que tiene ahora, con el pago y lo gastado desde entonces. El saldo según el libro que se muestra en cada cuenta es el libro de ese día (deja fuera el ingreso de este mismo chequeo y todo lo que tenga fecha posterior): parte de él y cámbialo solo si sabes que el libro está mal.",
    balanceMeaningDisclosure: "¿Qué cuenta como saldo reportado?",
    ledgerBalance: "Saldo según el libro",
    ledgerBalanceOn: (date: string) => `Saldo según el libro al ${date}`,
    reportedBalance: "Saldo reportado",
    matchesLedger: "Coincide con el libro",
    aboveLedger: (amount: string) => `${amount} por encima del libro`,
    belowLedger: (amount: string) => `${amount} por debajo del libro`,
    manageAccountsLink: "Administrar cuentas",
    noActiveAccountsTitle: "No hay cuentas activas",
    noActiveAccountsDescription: "Agrega o restaura una cuenta antes de iniciar un chequeo.",

    step2Title: "Registra el ingreso recibido",
    step2Description:
      "Opcional por cuenta - deja una cuenta en cero si no entró nada. Si una parte es única, como un bono, ingresa también esa parte: cuenta en este periodo y los siguientes no la esperan de nuevo.",
    incomeAmount: "Ingreso recibido",
    oneOffIncomeAmount: "De eso, único",
    oneOffIncomeTooHigh: "La parte única no puede ser mayor que el ingreso recibido.",
    ledgerDepositsHeading: "Ya en tu libro para este periodo",
    ledgerDepositEarmarked: (amount: string) => `menos ${amount} apartados para un pago recurrente`,
    ledgerDepositsSetAside: (count: number) =>
      count === 1
        ? "1 depósito marcado como único o apartado para un pago no cuenta como pago"
        : `${count} depósitos marcados como únicos o apartados para un pago no cuentan como pago`,
    ledgerDepositsHint:
      "El monto empieza en su suma, y se quedan como están. Escribe más si parte de este pago aún no está en el libro: solo la diferencia se registra como una nueva transacción de ingreso.",
    incomeBelowLedgerInline: (amount: string) =>
      `No puede ser menor que los ${amount} que ya están en tu libro para este periodo.`,
    incomeBelowLedger: (accounts: { name: string; inLedger: string }[]) =>
      `No se guardó nada: el ingreso de ${accounts.map((a) => `${a.name} no puede ser menor que los ${a.inLedger}`).join(", y el de ")} que ya están en tu libro para este periodo. Esos depósitos son el pago de este periodo y se quedan como están.`,
    incomeNotePlaceholder: "Salario, pago freelance, bono...",
    totalIncome: "Ingreso total",

    step3Title: "Revisa compromisos y metas",
    subscriptionsDue: "Suscripciones antes del próximo pago",
    contributionsDue: "Aportes recurrentes antes del próximo pago",
    noSubscriptionsDue: "No hay suscripciones antes del próximo pago.",
    noContributionsDue: "No hay aportes recurrentes antes del próximo pago.",
    bufferByAccountHeading: "Colchón protegido por cuenta",
    bufferByAccountDescription:
      "Cada cuenta guarda su propio colchón del ingreso que recibió. Mueve una suscripción a otra cuenta para cambiar lo que tiene que cubrir.",
    noIncomeAccountsYet:
      "Aún no hay ingresos registrados - anota en el paso 2 lo que recibió cada cuenta para ver su colchón.",
    accountIncomeReceived: "Ingreso recibido",
    accountSubscriptionsDue: "Suscripciones y aportes",
    accountLeftAfterSubscriptions: "Queda tras suscripciones y aportes",
    accountReportedSupports: "Alcanza (según tu saldo reportado)",
    accountReportedBelowProjection: (amount: string) =>
      `Tu saldo reportado alcanza para ${amount} menos de lo que proyecta el ingreso de este periodo - probablemente dinero que ya salió de esta cuenta antes de este chequeo.`,
    accountSuggestedBuffer: "Colchón sugerido",
    accountNoSubscriptionsDue: "Nada por pagar desde esta cuenta antes del próximo pago.",
    accountAboveBuffer: (amount: string) => `${amount} por encima de su colchón`,
    accountBelowBuffer: (amount: string) =>
      `Pagar todo lo que vence aquí quedaría corto por ${amount}.`,
    accountBelowBufferWithAlternative: (amount: string, accountName: string) =>
      `Pagar todo lo que vence aquí quedaría corto por ${amount} - ${accountName} tiene más margen este periodo.`,
    coverShortfallSuggestion: (amount: string, accountName: string) =>
      `Cúbrelo: mueve ${amount} desde ${accountName}.`,
    coverShortfallPartialSuggestion: (amount: string, accountName: string) =>
      `Cubre parte: mueve ${amount} desde ${accountName} - no alcanza para cerrar el faltante por completo.`,
    coverShortfallButton: "Cúbrelo",
    subscriptionAccountLabel: (name: string) => `Cuenta para ${name}`,
    unfundedSubscriptionsHeading: "Sin una cuenta con ingreso que las cubra",
    unfundedSubscriptionsDescription:
      "Vencen antes del próximo pago pero su cuenta no recibió ingreso en este chequeo. Muévelas a una que sí.",
    alreadyPaidThisPeriod: "Ya pagado este período",
    wontPostHeading: "Sin contar: el registro automático las omite",
    wontPostDescription:
      "No se cobrará nada por ellas hasta que corrijas el motivo en la página de recurrentes, así que este plan las deja fuera.",
    goalReachedKept: (amount: string) =>
      `Alcanzada desde que se confirmó este plan - sus ${amount} siguen en el plan.`,
    archivedAccountNote: "archivada, se conserva como registro",
    overdueBadge: "Vencido",
    chargesThisPeriod: (count: number, each: string) => `${count} cargos de ${each}`,
    // Ingreso apartado para un pago recurrente (src/lib/earmarks.ts).
    coveredBy: (amount: string, deposit: string) => `${amount} cubierto por ${deposit}`,
    depositOf: (date: string) => `el depósito del ${date}`,
    goalsHeading: "Hoja de ruta de metas",
    goalsDescription:
      "Cada meta se financia desde las cuentas a las que les sobra dinero tras sus suscripciones, aportes recurrentes y su colchón, en proporción al margen de cada una. Ajusta la parte de cualquier cuenta; el total de la meta es la suma.",
    noGoalsToReserve: "No hay metas que reservar en este periodo.",
    roadmapAmount: "Monto de la hoja de ruta",
    roadmapScheduled: (amount: string) => `+ ${amount} de aportes recurrentes`,
    remainingBalanceNoDate: "Saldo restante (sin fecha objetivo)",
    remainingBalanceNoDateHint:
      "recomendado completo hasta donde alcance el margen de las cuentas - no hay fecha contra la cual marcar el ritmo",
    plannedAmount: "Monto planificado",
    goalPlannedTotal: "Total planificado",
    goalFundingRecommended: "Recomendado",
    goalFundingAccountLabel: (goalName: string, accountName: string) =>
      `${goalName} desde ${accountName}`,
    goalFundingRoom: (amount: string, sharePercent: number) =>
      `${amount} de sobra tras sus suscripciones, aportes y colchón · ${sharePercent}% del margen`,
    goalFundingRoomAfterEarlierGoals: (amount: string, sharePercent: number) =>
      `${amount} aún de sobra tras las metas de arriba · ${sharePercent}% del margen`,
    goalFundingNoRoomLeft: "No queda nada de sobra tras las metas de arriba",
    goalFundingLeadAccount: (accountName: string) =>
      `${accountName} tiene más margen este periodo tras sus suscripciones, aportes y colchón, así que toma la parte mayor.`,
    goalFundingNoRoom:
      "A ninguna cuenta le sobra dinero tras sus suscripciones, aportes y colchón este periodo, así que no se puede reservar nada para esta meta del excedente.",
    goalFundingShortfall: (free: string, short: string) =>
      `Solo sobran ${free} entre tus cuentas - ${short} del monto de la hoja de ruta de esta meta no se puede cubrir con el excedente este periodo.`,
    goalOnTrack: "Al día con la hoja de ruta",
    goalBehind: (amount: string) => `${amount} por detrás de la hoja de ruta`,
    goalAhead: (amount: string) => `${amount} por delante de la hoja de ruta`,
    goalRemainingFunded: "Cubre todo el saldo restante",
    goalRemainingLeft: (amount: string) => `${amount} del saldo restante queda para un periodo posterior`,
    goalRemainingOver: (amount: string) => `${amount} más que el saldo restante`,
    bufferZeroWarning: "Este plan no deja colchón protegido para gastos imprevistos.",
    essentialCategoriesHeading: "Gastos fijos esenciales",
    noEssentialCategoriesConfigured:
      "Aún no hay categorías marcadas como fijas esenciales - configúralas en Ajustes.",
    carryoverHeading: "Remanente del periodo anterior",
    carryoverAvailable: (amount: string) => `${amount} sin gastar del presupuesto anterior`,
    carryoverUnavailable:
      "No hay presupuesto del periodo anterior para medir el remanente - este plan se financia solo con el ingreso.",
    carryoverProvisional: (amount: string) =>
      `${amount} sin gastar hasta ahora del presupuesto anterior. El periodo anterior aún no termina, así que es provisional: el plan no cuenta nada de esto ahora y cuenta lo que ese periodo realmente deje cuando termine.`,
    carryoverIncluded: "Incluir en este plan",
    summaryIncome: "Ingreso",
    summaryCarryover: "Remanente incluido",
    summaryCarryoverProvisional: (amount: string) => `${amount} provisional - se cuenta cuando termine el periodo anterior`,
    carryoverAdjusted: (by: string, period: string) =>
      `Remanente ajustado en ${by} desde que se asentó: lo que dejó ${period} cambió después de terminar, por ejemplo gastos con fecha en ese periodo que se registraron más tarde.`,
    incomeAdjusted: (by: string) =>
      `Ingreso ajustado en ${by} desde que confirmaste: cambió un depósito que este plan cuenta como pago: se apartó parte para un pago o cambió ese monto, o se editó, se marcó como único o se eliminó.`,
    summaryCushion: "Ya en tus cuentas",
    summaryCushionHint: "Lo que tus cuentas tenían antes de este pago. Se guarda como reserva: no cuenta en este plan.",
    summarySubscriptions: "Suscripciones",
    summaryContributions: "Aportes recurrentes",
    summaryGoals: "Plan de metas",
    summaryEssential: "Fijos esenciales",
    summaryBuffer: "Colchón protegido",
    summaryReconciliationCap: "Tope por tu saldo reportado",
    summaryAvailable: "Disponible para categorías flexibles",
    deficitWarning: (amount: string) =>
      `Este plan queda corto por ${amount} - algo de lo anterior tiene que ceder antes de poder asignar categorías flexibles.`,

    step4Title: "Planifica las categorías flexibles",
    noSuggestionsYetNote:
      "Aún no hay historial de gastos, así que no hay montos sugeridos. Ingresa lo que quieras permitir en cada categoría, o déjalas en 0 y define los presupuestos más tarde en Presupuestos: el dinero de tus cuentas no cambia en ningún caso.",
    suggested: "Sugerido",
    basisLastBudget: "último presupuesto",
    basisAverage: "promedio",
    basisNone: "sin historial suficiente",
    flexibleAllocated: "Asignado",
    flexibleUnallocated: "Sin asignar",
    flexibleUnallocatedCarries:
      "No se guarda como presupuesto. Lo que quede sin asignar, y lo que los presupuestos no gasten, pasa al chequeo del próximo periodo.",
    flexibleDeficitNote:
      "Este plan no deja nada para categorías flexibles, así que cada sugerencia queda en 0. Libera dinero en el paso 3 o déjalas en 0.",
    flexibleOverallocated: (amount: string) => `${amount} sobreasignado`,
    noFlexibleCategoriesConfigured:
      "No hay categorías flexibles disponibles - cada categoría de gasto es fija esencial o está excluida.",
    acknowledgeDeficitLabel:
      "Entiendo que este plan queda corto y algo de lo anterior debe cambiar, o el gasto será más ajustado de lo planeado.",

    step5Title: "Confirma tu plan",
    confirmSnapshotsNote:
      "Los saldos reportados se registran solo para auditoría - nunca cambian el saldo de la cuenta.",
    confirmIncomeNote: (counts: { created: number; updated: number; removed: number; adopted: number }, amount: string) => {
      const parts = [
        counts.created > 0 ? `${counts.created} ${counts.created === 1 ? "se crea" : "se crean"}` : null,
        counts.updated > 0 ? `${counts.updated} ${counts.updated === 1 ? "se actualiza" : "se actualizan"}` : null,
        counts.removed > 0 ? `${counts.removed} ${counts.removed === 1 ? "se elimina" : "se eliminan"}` : null,
      ].filter((part): part is string => part !== null);
      const adopted =
        counts.adopted > 0
          ? `${counts.adopted} ${counts.adopted === 1 ? "depósito que ya está" : "depósitos que ya están"} en tu libro ${counts.adopted === 1 ? "cuenta tal como está" : "cuentan tal como están"}, sin registrarse de nuevo`
          : null;
      if (parts.length === 0) return adopted ? `Ingreso, ${amount} en total: ${adopted}.` : "No se crea ni cambia ninguna transacción de ingreso.";
      const changed = counts.created + counts.updated + counts.removed;
      return `Transacciones de ingreso, ${amount} en total: ${parts.join(", ")}${changed === counts.created ? "" : " - las que este chequeo ya había registrado se cambian en su lugar, no se agregan de nuevo"}${adopted ? `; ${adopted}` : ""}.`;
    },
    confirmUnallocatedNote: (amount: string) =>
      `${amount} queda sin asignar: no se guarda como presupuesto y pasa al chequeo del próximo periodo junto con lo que los presupuestos no gasten.`,
    confirmCushionNote: (amount: string) =>
      `${amount} ya estaba en tus cuentas antes de este pago. Se queda ahí como reserva y no cuenta en este plan.`,
    confirmBudgetsNote: (count: number) =>
      `Se ${count === 1 ? "creará o actualizará" : "crearán o actualizarán"} ${count} presupuesto${count === 1 ? "" : "s"} de categoría para este periodo.`,
    confirmReservedNote:
      "Las suscripciones, los aportes recurrentes y los montos de metas quedan reservados en el plan, pero no se registran como transacciones o aportes reales.",
    confirmNoAllocationsNote:
      "Aún no hay montos asignados a categorías: puedes definir o cambiar los presupuestos por categoría en cualquier momento en Presupuestos.",
    noAllocationsSavedNote: "Aún no hay asignaciones por categoría guardadas.",
    setBudgetsLink: "Definir presupuestos",
    acknowledgeZeroBufferLabel: "Entiendo que este plan no deja colchón protegido.",
    confirmPlan: "Confirmar plan",
    checkinConfirmed: "Chequeo de pago confirmado",
    checkinConfirmedScaled: (from: string, to: string) =>
      `Chequeo de pago confirmado. Los presupuestos flexibles se redujeron de ${from} a ${to} - lo que alcanza tu saldo reportado.`,
    editConfirmedPlanNote:
      "Ya confirmaste el chequeo de este periodo - guardar de nuevo lo actualiza en su lugar.",

    couldNotReadPlan: "No se pudo leer el plan - intenta de nuevo",
    noActiveAccounts: "Agrega al menos una cuenta activa antes de hacer el chequeo",
    acknowledgeDeficitFirst: "Reconoce la advertencia de déficit o sobreasignación antes de confirmar",
    confirmedMeanwhile:
      "Este chequeo se confirmó desde otra ventana o con un segundo toque mientras se guardaba este, así que esta vez no se guardó nada. Cierra el chequeo y ábrelo de nuevo para ver el plan que quedó guardado.",
    acknowledgeZeroBufferFirst: "Reconoce la advertencia de colchón en cero antes de confirmar",
    changedSinceLoaded:
      "Este chequeo se cambió en otra pestaña o ventana después de que lo abriste, así que no se guardó nada. Recarga la página para ver el plan como está ahora y vuelve a hacer tus cambios.",
    depositsChangedSinceLoaded:
      "Los depósitos cambiaron desde que abriste este chequeo, así que no se guardó nada. Recarga la página para verlos como están ahora y vuelve a confirmar.",
  },
} as const satisfies Dictionary;
