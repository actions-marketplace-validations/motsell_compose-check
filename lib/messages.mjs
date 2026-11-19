// Only fixed phrases, numeric counters and ordinal service positions reach output.
// Never interpolate source names, file paths, environment variables or raw errors.
const findings = {
  MOUNT_MAPPING_REVIEW: ['Review unresolved mount mappings in normalized output.', 'Сверьте нераскрытые подключения файлов и томов в нормализованном выводе.'],
  DATA_MOUNT_NOT_FOUND: ['No writable named volume or host directory found for a possible database/cache. If data must survive replacement, verify the real data path and recovery.', 'У возможной базы или кеша не найден записываемый именованный том или каталог хоста. Если данные должны пережить пересоздание, проверьте путь данных и восстановление.'],
  DATA_RESTORE_REVIEW: ['Verify the data directory matches the persistent mount; rehearse recovery separately.', 'Сверьте путь данных с постоянным томом и отдельно проверьте восстановление.'],
  VOLUME_BACKUP_REVIEW: ['Inventory volume data and verify its transfer and recovery, including anonymous volumes.', 'Учтите содержимое томов и проверьте перенос и восстановление, в том числе анонимных томов.'],
  BIND_MOUNT_REVIEW: ['Transfer required host files/directories and verify permissions on the destination.', 'Перенесите нужные файлы и каталоги хоста и проверьте права на целевой машине.'],
  DATA_PORT_PUBLICATION_REVIEW: ['A possible data-service port mapping is not restricted to loopback. Review whether publication is necessary; no reachability test was performed.', 'Публикация порта возможной базы не ограничена loopback. Проверьте её необходимость; доступность не проверялась.'],
  PORT_MAPPING_REVIEW: ['Review final bind addresses and port mappings after normalization.', 'Сверьте итоговые адреса и порты после нормализации.'],
  BUILD_CONTEXT_REVIEW: ['Verify that the build context is available and builds on the destination architecture.', 'Проверьте доступность контекста сборки и возможность сборки на архитектуре целевой машины.'],
  PLATFORM_REVIEW: ['Verify the explicitly selected platform is compatible with the destination.', 'Проверьте совместимость явно выбранной платформы с целевой машиной.'],
  HOST_NETWORK_REVIEW: ['Host networking is configured. Review port allocation on the destination.', 'Указан режим сети хоста. Сверьте распределение портов на целевой машине.'],
  DEPENDENCY_REVIEW: ['Review declared startup dependencies and required service readiness on restore.', 'Сверьте порядок запуска зависимостей и готовность сервисов после восстановления.'],
  ENV_FILE_REVIEW: ['Review required environment files on the destination; their contents were not read.', 'Проверьте наличие нужных файлов окружения на целевой машине; их содержимое не читалось.'],
  EXTERNAL_VOLUMES_REVIEW: ['Prepare external volumes and their data on the destination.', 'Подготовьте внешние тома и их данные на целевой машине.'],
  EXTERNAL_NETWORKS_REVIEW: ['Verify that required external networks exist on the destination.', 'Проверьте наличие необходимых внешних сетей на целевой машине.'],
  EXTERNAL_SECRETS_REVIEW: ['Prepare required external secrets through your authorized secret-management process.', 'Подготовьте внешние секреты через разрешённый процесс управления секретами.'],
  EXTERNAL_CONFIGS_REVIEW: ['Provide required external configs in the destination environment.', 'Подготовьте внешние конфигурации в целевом окружении.'],
  CONFIG_INPUT_REVIEW: ['Inventory config and secret file/environment dependencies; their values were not read separately.', 'Учтите зависимости конфигураций и секретов от файлов и окружения; их значения отдельно не читались.']
};

const errors = {
  INVALID_ARGS: ['Invalid arguments. See --help.', 'Недопустимые аргументы. См. --help.'],
  INPUT_REQUIRED: ['Pipe normalized JSON to stdin or specify --file PATH.', 'Передайте нормализованный JSON через stdin или укажите --file PATH.'],
  FILE_NOT_REGULAR: ['Input must be an explicitly named regular file, not a symlink, URL or special file.', 'Нужен явно указанный обычный файл, не ссылка, URL или специальный файл.'],
  INPUT_READ_FAILED: ['Could not read input.', 'Не удалось прочитать ввод.'],
  INPUT_TOO_LARGE: ['Input exceeds 250,000 bytes.', 'Размер ввода превышает 250 000 байт.'],
  INVALID_JSON: ['Invalid UTF-8 JSON. Use the complete normalized Compose JSON.', 'Неверный JSON в UTF-8. Используйте полный нормализованный JSON Compose.'],
  INVALID_CONFIG: ['Expected an object with an object-valued services section.', 'Нужен объект с разделом services в виде объекта.'],
  INVALID_SERVICES: ['Expected 1–80 object-valued services with ordinary Compose names (1–64 characters).', 'Допустимо от 1 до 80 сервисов-объектов с обычными именами Compose (1–64 символа).'],
  INVALID_MAPPINGS: ['Expected arrays of normalized port and volume mappings.', 'Нужны массивы нормализованных подключений портов и томов.']
};

const langIndex = lang => lang === 'ru' ? 1 : 0;

export function errorMessage(code, lang) {
  return (errors[code] ?? errors.INPUT_READ_FAILED)[langIndex(lang)];
}

export function render(report, lang) {
  const i = langIndex(lang);
  const lines = [i === 1
    ? `Сервисы: ${report.services}. Возможные базы и кеши: ${report.possibleDatabases}. Записи о публикации портов: ${report.publishedPortEntries}.`
    : `Services: ${report.services}. Possible databases/caches: ${report.possibleDatabases}. Published-port entries: ${report.publishedPortEntries}.`];
  if (!report.findings.length) lines.push(i === 1 ? 'По этим правилам замечаний не найдено.' : 'No findings under these rules.');
  for (const finding of report.findings) {
    const scope = finding.service === null ? (i ? 'проект' : 'project') : (i ? 'сервис' : 'service') + ` #${finding.service}`;
    const priority = finding.priority === 'important' ? (i ? 'важно' : 'important') : (i ? 'проверить' : 'review');
    lines.push(`[${priority}] ${scope} ${finding.code}: ${findings[finding.code][i]}`);
  }
  lines.push(i === 1 ? 'Это подсказки для ручной проверки, а не гарантия безопасности или успешной миграции.' : 'These are manual-review cues, not a security or migration guarantee.');
  return lines.join('\n') + '\n';
}
