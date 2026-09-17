/**
 * Словарь интерфейсных текстов (docs/08-ui-ux.md §7).
 *
 * Локаль только `ru-RU`, но тексты собраны в одном месте: это задел на
 * мультиязычность и, главное, защита от расхождений — одна и та же подпись
 * в разных экранах должна выглядеть одинаково.
 */
export const t = {
  app: {
    title: 'Ремонт ювелирных изделий',
    shortTitle: 'Ремонт',
  },

  nav: {
    dashboard: 'Дашборд',
    orders: 'Заказы',
    newOrder: 'Новый заказ',
    payments: 'Приём оплаты',
    search: 'Поиск',
    profile: 'Профиль',
    logout: 'Выйти',
    users: 'Сотрудники',
  },

  /**
   * Экран управления учётными записями (задача 1.2.4).
   *
   * Подписи собраны здесь, а не в разметке: этот экран администратора
   * переиспользует те же формулировки в списке, карточке и подтверждениях,
   * и расхождение между ними читалось бы как разные операции.
   */
  users: {
    title: 'Сотрудники',
    subtitle: 'Учётные записи, роли и доступ к магазинам',
    empty: 'Сотрудники не найдены',
    emptyHint: 'Измените фильтры или создайте учётную запись',
    search: 'ФИО, e-mail или телефон',
    filterActive: 'Все',
    filterActiveOnly: 'Только активные',
    filterInactiveOnly: 'Только отключённые',
    create: 'Создать сотрудника',
    createTitle: 'Новый сотрудник',
    fullName: 'ФИО',
    email: 'E-mail',
    phone: 'Телефон',
    password: 'Пароль',
    passwordHint:
      'Минимум 12 символов: строчная, прописная и цифра. Сотрудник сменит его при входе.',
    roles: 'Роли',
    stores: 'Магазины',
    store: 'Магазин',
    scope: 'Область видимости',
    role: 'Роль',
    addRole: 'Добавить роль',
    revoke: 'Снять',
    revokeConfirm: 'Снять роль «{role}»?',
    revokeSessionsHint: 'Снятие роли завершит активные сессии сотрудника.',
    active: 'Активна',
    inactive: 'Отключена',
    mustChange: 'Требуется смена пароля',
    sessions: 'Сессий',
    lastLogin: 'Последний вход',
    never: 'Ни разу',
    locked: 'Заблокирована',
    storeCount: 'Магазинов',
    disabled: 'Отключить',
    enabled: 'Включить',
    disableConfirm: 'Отключить сотрудника? Его активные сессии будут завершены.',
    resetPassword: 'Сбросить пароль',
    resetTitle: 'Сброс пароля',
    resetHint: 'Все активные сессии сотрудника завершатся. Передайте пароль лично.',
    resetDone: 'Пароль сброшен',
    created: 'Сотрудник создан',
    updated: 'Изменения сохранены',
    roleAssigned: 'Роль назначена',
    roleRevoked: 'Роль снята',
    permissions: 'Права',
    noPermissions: 'Права не назначены',
    noRoles: 'Роли не назначены — сотрудник не сможет войти',
    loadError: 'Не удалось загрузить список сотрудников',
    forbidden: 'Управление сотрудниками доступно только администратору',
    storeRequired: 'Для этой роли нужно выбрать магазин',
    selfDisable: 'Нельзя отключить собственную учётную запись',
  },

  login: {
    title: 'Вход в систему',
    subtitle: 'Управление и контроль операций ремонта',
    email: 'E-mail',
    password: 'Пароль',
    submit: 'Войти',
    submitting: 'Вход…',
    failed: 'Не удалось войти',
  },

  orders: {
    title: 'Заказы',
    empty: 'Заказы не найдены',
    emptyHint: 'Измените фильтры или создайте новый заказ',
    loadMore: 'Показать ещё',
    loading: 'Загрузка…',
    orderNo: 'Номер',
    customer: 'Клиент',
    status: 'Статус',
    amount: 'Сумма',
    paid: 'Оплачено',
    due: 'Срок',
    store: 'Магазин',
    priority: 'Приоритет',
    overdue: 'Просрочен',
    warranty: 'Гарантийный',
    filters: 'Фильтры',
    resetFilters: 'Сбросить',
    searchPlaceholder: 'Номер заказа, телефон или ФИО',
  },

  order: {
    title: 'Заказ',
    notFound: 'Заказ не найден',
    tabs: {
      overview: 'Обзор',
      calc: 'Калькуляция',
      payments: 'Платежи',
      approvals: 'Согласования',
      history: 'История',
    },
    item: 'Изделие',
    money: 'Деньги',
    total: 'Итого',
    paid: 'Оплачено',
    remaining: 'Осталось',
    prepayment: 'Предоплата',
    prepaymentDone: 'внесена',
    prepaymentMissing: 'не внесена',
    production: 'Производство',
    workshop: 'Цех',
    createdBy: 'Принял',
    description: 'Дефект',
    diagnosis: 'Заключение',
    customer: 'Клиент',
    dueAt: 'Срок',
    noDueDate: 'не задан',
    daysLeft: 'осталось',
    daysOverdue: 'просрочено на',
    days: 'дн.',
    actions: 'Действия',
    transition: 'Перевести статус',
    cancel: 'Отменить заказ',
    noActions: 'Нет доступных действий',
    historyEmpty: 'Событий пока нет',
    paymentsEmpty: 'Платежей нет',
    approvalsEmpty: 'Согласований нет',
    calcEmpty: 'Калькуляция пуста',
  },

  transition: {
    title: 'Перевод статуса',
    to: 'Новый статус',
    reason: 'Причина',
    reasonRequired: 'Укажите причину',
    submit: 'Подтвердить',
    submitting: 'Выполняется…',
    success: 'Статус изменён',
    failed: 'Не удалось изменить статус',
  },

  cancel: {
    title: 'Отмена заказа',
    warning: 'Отмена необратима. Заказ будет закрыт без ремонта.',
    reason: 'Причина отмены',
    submit: 'Отменить заказ',
    submitting: 'Отмена…',
    success: 'Заказ отменён',
  },

  dashboard: {
    title: 'Дашборд',
    greeting: 'Здравствуйте',
    overview: 'Обзор',
    totalOrders: 'Всего заказов',
    inProduction: 'В производстве',
    readyForPickup: 'Готовы к выдаче',
    unclaimed: 'Невостребованные',
    overdue: 'Просроченные',
    awaitingPrepayment: 'Ожидают предоплату',
    myOrders: 'Мои заказы',
    quickActions: 'Быстрые действия',
  },

  common: {
    retry: 'Повторить',
    close: 'Закрыть',
    cancel: 'Отмена',
    save: 'Сохранить',
    saving: 'Сохранение…',
    edit: 'Изменить',
    refresh: 'Сгенерировать',
    back: 'Назад',
    error: 'Произошла ошибка',
    loading: 'Загрузка…',
    yes: 'Да',
    no: 'Нет',
    all: 'Все',
    of: 'из',
    russian: 'Русский',
  },

  errors: {
    network: 'Нет связи с сервером. Проверьте подключение.',
    unauthorized: 'Сессия истекла. Войдите заново.',
    forbidden: 'Недостаточно прав для этого действия',
    notFound: 'Запись не найдена',
    server: 'Ошибка на сервере. Попробуйте позже.',
  },
} as const;

/** Приоритеты заказа: отображение в интерфейсе. */
export const PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Низкий',
  NORMAL: 'Обычный',
  HIGH: 'Высокий',
  URGENT: 'Срочный',
};

/** Цвета бейджа приоритета. */
export const PRIORITY_COLORS: Record<string, string> = {
  LOW: 'slate',
  NORMAL: 'slate',
  HIGH: 'amber',
  URGENT: 'red',
};

/**
 * Вид платежа.
 *
 * REFUND показывается как «Возврат», а не «Возврат средств»: подпись стоит в
 * узкой колонке истории платежей, и длинный текст ломает строку.
 */
export const PAYMENT_KIND_LABELS: Record<string, string> = {
  PREPAYMENT: 'Предоплата',
  FINAL: 'Окончательный расчёт',
  ADDITIONAL: 'Доплата',
  REFUND: 'Возврат',
  REVERSAL: 'Сторно',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Наличные',
  CARD: 'Карта',
  BANK_TRANSFER: 'Безналичный перевод',
  ONLINE: 'Онлайн',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Ожидает подтверждения',
  CONFIRMED: 'Подтверждён',
  FAILED: 'Не прошёл',
  REVERSED: 'Отменён',
};
