// Pure comparison of two normalized Docker Compose JSON snapshots. This is a
// bounded, offline review of metadata, never a deployment or data restore test.
const MAX_COMPARE_BYTES = 250_000;
const MAX_SERVICES = 80;
const MAX_RESOURCES = 128;
const MAX_MAPPINGS = 128;
const MAX_VALUES = 40_000;
const MAX_DEPTH = 48;
const MAX_FINDINGS = 1200;
const resourceKinds = ['volumes', 'networks', 'configs', 'secrets'];

class CompareError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const resolved = value => nonempty(value) && !value.includes('${');
const logicalName = value => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function requireShape(condition) { if (!condition) throw new CompareError('INVALID_SHAPE'); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (obj(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const same = (a, b) => canonical(a) === canonical(b);
const pick = (object, keys) => Object.fromEntries(keys.filter(key => has(object, key)).map(key => [key, object[key]]));
const indexMap = entries => new Map(entries.map(([key, value], index) => [key, { value, index: index + 1 }]));
const multiset = values => values.map(canonical).sort();

function inspectTree(root) {
  let visits = 0, unresolved = false;
  const stack = [[root, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++visits > MAX_VALUES || depth > MAX_DEPTH) throw new CompareError('STRUCTURE_LIMIT');
    if (typeof value === 'number') requireShape(Number.isFinite(value));
    else if (typeof value === 'string') unresolved ||= value.includes('${');
    else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return unresolved;
}
function indexedResources(config, kind) {
  const map = config[kind] ?? {};
  requireShape(obj(map) && Object.keys(map).length <= MAX_RESOURCES);
  const entries = Object.entries(map);
  requireShape(entries.every(([name, value]) => logicalName(name) && obj(value) && (value.name == null || nonempty(value.name)) && (value.external == null || typeof value.external === 'boolean')));
  return indexMap(entries);
}
function indexedMounts(service) {
  const mounts = service.volumes ?? [];
  requireShape(Array.isArray(mounts) && mounts.length <= MAX_MAPPINGS);
  const result = new Map();
  for (const [index, mount] of mounts.entries()) {
    requireShape(obj(mount) && nonempty(mount.type) && nonempty(mount.target) &&
      (mount.source == null || typeof mount.source === 'string') && (mount.read_only == null || typeof mount.read_only === 'boolean'));
    requireShape(!result.has(mount.target)); // no guessing duplicate targets
    result.set(mount.target, { value: mount, index: index + 1 });
  }
  return result;
}
function optionalRecord(value) { return value == null || obj(value); }
function optionalString(value) { return value == null || typeof value === 'string'; }

function parseSnapshot(bytes, side) {
  try {
    requireShape(ArrayBuffer.isView(bytes));
    if (!bytes.byteLength) throw new CompareError('INPUT_REQUIRED');
    if (bytes.byteLength > MAX_COMPARE_BYTES) throw new CompareError('INPUT_TOO_LARGE');
    let cfg;
    try { cfg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new CompareError('INVALID_JSON'); }
    inspectTree(cfg);
    requireShape(obj(cfg) && obj(cfg.services) && optionalString(cfg.name));
    const entries = Object.entries(cfg.services);
    requireShape(entries.length >= 1 && entries.length <= MAX_SERVICES && entries.every(([key, service]) => logicalName(key) && obj(service)));
    const services = indexMap(entries);
    const resources = Object.fromEntries(resourceKinds.map(kind => [kind, indexedResources(cfg, kind)]));
    for (const service of services.values()) {
      const s = service.value;
      service.mounts = indexedMounts(s);
      service.unresolved = inspectTree(s);
      requireShape(optionalString(s.image) && optionalString(s.platform) && optionalString(s.network_mode) && optionalRecord(s.build) && optionalRecord(s.healthcheck) && optionalRecord(s.environment) && optionalRecord(s.depends_on) && optionalRecord(s.networks));
      requireShape(Object.keys(s.depends_on ?? {}).length <= MAX_SERVICES && Object.entries(s.depends_on ?? {}).every(([name, value]) => logicalName(name) && obj(value)));
      requireShape(Object.keys(s.networks ?? {}).length <= MAX_RESOURCES && Object.entries(s.networks ?? {}).every(([name, value]) => logicalName(name) && optionalRecord(value)));
      for (const key of ['ports', 'configs', 'secrets', 'env_file']) {
        const values = s[key] ?? [];
        requireShape(Array.isArray(values) && values.length <= MAX_MAPPINGS && values.every(value => obj(value) || key !== 'ports' && nonempty(value)));
      }
      requireShape((s.ports ?? []).every(port => (typeof port.target === 'string' || Number.isInteger(port.target)) && optionalString(port.host_ip)));
    }
    return { name: cfg.name, services, resources };
  } catch (error) {
    throw new CompareError(side + '_' + (error instanceof CompareError ? error.code : 'INVALID_SHAPE'));
  }
}

const resourceDefinitionFields = {
  volumes: ['driver', 'driver_opts'],
  networks: ['driver', 'driver_opts', 'internal', 'attachable', 'enable_ipv6', 'enable_ipv4', 'ipam'],
  configs: ['file', 'environment'],
  secrets: ['file', 'environment'],
};
const resourceScope = { volumes: 'volume', networks: 'network', configs: 'config', secrets: 'secret' };

function compareComposeBytes(sourceBytes, destinationBytes) {
  const source = parseSnapshot(sourceBytes, 'SOURCE');
  const dest = parseSnapshot(destinationBytes, 'DESTINATION');
  const findings = [];
  const add = (code, priority, scope, a, b, ai = null, bi = null) => {
    if (findings.length >= MAX_FINDINGS) throw new CompareError('REPORT_LIMIT');
    findings.push({ code, priority, scope, source: a?.index ?? null, destination: b?.index ?? null, sourceItem: ai, destinationItem: bi });
  };
  if (!resolved(source.name) || !resolved(dest.name)) add('PROJECT_NAME_REVIEW', 'review', 'project');
  else if (source.name !== dest.name) add('PROJECT_NAME_CHANGED', 'review', 'project');

  for (const kind of resourceKinds) {
    const aMap = source.resources[kind], bMap = dest.resources[kind], scope = resourceScope[kind];
    for (const [key, a] of aMap) {
      const b = bMap.get(key);
      if (!b) { add('RESOURCE_MISSING', 'important', scope, a, null); continue; }
      const av = a.value, bv = b.value;
      if (kind === 'volumes' || kind === 'networks') {
        if (!resolved(av.name) || !resolved(bv.name)) add('PHYSICAL_NAME_REVIEW', 'review', scope, a, b);
        else if (av.name !== bv.name) add(kind === 'volumes' ? 'VOLUME_PHYSICAL_NAME_CHANGED' : 'NETWORK_PHYSICAL_NAME_CHANGED', 'important', scope, a, b);
      } else {
        // Names/references only; never compare config/secret content or values.
        add('CONFIG_SECRET_REVIEW', 'review', scope, a, b);
        if (av.name !== bv.name) add('RESOURCE_NAME_CHANGED', 'review', scope, a, b);
      }
      if ((av.external === true) !== (bv.external === true)) add('EXTERNAL_RESOURCE_CHANGED', 'important', scope, a, b);
      if (!same(pick(av, resourceDefinitionFields[kind]), pick(bv, resourceDefinitionFields[kind]))) add('RESOURCE_DEFINITION_CHANGED', 'review', scope, a, b);
    }
    for (const [key, b] of bMap) if (!aMap.has(key)) add('RESOURCE_ADDED', 'review', scope, null, b);
  }

  function checkReferences(snapshot, service, sourceSide) {
    const a = sourceSide ? service : null, b = sourceSide ? null : service, s = service.value;
    if (service.unresolved) add('UNRESOLVED_FIELDS_REVIEW', 'review', 'service', a, b);
    if (Object.keys(s.depends_on ?? {}).some(name => !snapshot.services.has(name))) add('DEPENDENCY_REFERENCE_UNRESOLVED', 'important', 'service', a, b);
    if (Object.keys(s.networks ?? {}).some(name => !snapshot.resources.networks.has(name))) add('NETWORK_REFERENCE_UNRESOLVED', 'important', 'service', a, b);
    for (const mount of service.mounts.values()) {
      const m = mount.value;
      const si = sourceSide ? mount.index : null, di = sourceSide ? null : mount.index;
      if (!resolved(m.target) || m.type === 'bind' && !resolved(m.source) || !['volume','bind','tmpfs','image','npipe','cluster'].includes(m.type)) add('MOUNT_MAPPING_REVIEW', 'review', 'mount', a, b, si, di);
      if (m.type === 'volume') {
        if (!resolved(m.source)) add('VOLUME_SOURCE_REVIEW', 'review', 'mount', a, b, si, di);
        else if (!snapshot.resources.volumes.has(m.source)) add('VOLUME_REFERENCE_UNRESOLVED', 'important', 'mount', a, b, si, di);
      }
    }
  }
  for (const service of source.services.values()) checkReferences(source, service, true);
  for (const service of dest.services.values()) checkReferences(dest, service, false);

  for (const [name, a] of source.services) {
    const b = dest.services.get(name);
    if (!b) { add('SERVICE_MISSING', 'important', 'service', a, null); continue; }
    const av = a.value, bv = b.value;
    const serviceChange = (code, priority = 'review') => add(code, priority, 'service', a, b);
    for (const [key, code] of [['image','IMAGE_CHANGED'], ['platform','PLATFORM_CHANGED'], ['network_mode','NETWORK_MODE_CHANGED']]) if ((av[key] ?? null) !== (bv[key] ?? null)) serviceChange(code);
    if (!same(pick(av.build ?? {}, ['context','dockerfile','target','platforms']), pick(bv.build ?? {}, ['context','dockerfile','target','platforms'])) || Boolean(av.build) !== Boolean(bv.build)) serviceChange('BUILD_CHANGED');
    if (!same(multiset(av.ports ?? []), multiset(bv.ports ?? []))) serviceChange('PORTS_CHANGED');
    if (!same(av.networks ?? {}, bv.networks ?? {})) serviceChange('NETWORK_ATTACHMENTS_CHANGED');
    if (!same(av.depends_on ?? {}, bv.depends_on ?? {})) serviceChange('STARTUP_DEPENDENCIES_CHANGED');
    if (!same(av.healthcheck ?? {}, bv.healthcheck ?? {})) serviceChange('HEALTHCHECK_CHANGED');
    if (!same(Object.keys(av.environment ?? {}).sort(), Object.keys(bv.environment ?? {}).sort()) || !same(av.env_file ?? [], bv.env_file ?? [])) serviceChange('ENVIRONMENT_INPUTS_CHANGED');
    if (!same(multiset(av.configs ?? []), multiset(bv.configs ?? [])) || !same(multiset(av.secrets ?? []), multiset(bv.secrets ?? []))) serviceChange('CONFIG_SECRET_ATTACHMENTS_CHANGED');
    for (const [target, x] of a.mounts) {
      const y = b.mounts.get(target);
      if (!y) { add('MOUNT_MISSING', 'important', 'mount', a, b, x.index, null); continue; }
      const xm = x.value, ym = y.value;
      if (xm.type !== ym.type || (xm.source ?? null) !== (ym.source ?? null)) add('MOUNT_SOURCE_CHANGED', 'important', 'mount', a, b, x.index, y.index);
      if ((xm.read_only === true) !== (ym.read_only === true) || !same(pick(xm, ['bind','volume','tmpfs','image','consistency']), pick(ym, ['bind','volume','tmpfs','image','consistency']))) add('MOUNT_OPTIONS_CHANGED', 'review', 'mount', a, b, x.index, y.index);
    }
    for (const [target, y] of b.mounts) if (!a.mounts.has(target)) add('MOUNT_ADDED', 'review', 'mount', a, b, null, y.index);
  }
  for (const [name, b] of dest.services) if (!source.services.has(name)) add('SERVICE_ADDED', 'review', 'service', null, b);
  return { schemaVersion: 1, mode: 'compare', status: 'manual_review_required', sourceServices: source.services.size, destinationServices: dest.services.size,
    findings: findings.sort((a, b) => Number(b.priority === 'important') - Number(a.priority === 'important')) };
}

const copy = {
  en: {
    title: 'Compare source and destination', important: 'Important', review: 'Review',
    summary: (a,b,n) => `${a} source services · ${b} destination services · ${n} review items.`,
    equal: 'No differences detected in the checked fields. Verify the destination separately.',
    note: 'This is a configuration comparison, not proof that volumes, data, credentials or the application were restored. Same names do not copy data. Environment values and arbitrary service parameters are not compared.',
    scope: { project: 'Project', service: 'Service', mount: 'Service', volume: 'Volume', network: 'Network', config: 'Config', secret: 'Secret' }, mount: 'mount',
    source: 'Source', destination: 'Destination',
    errors: { INPUT_REQUIRED:'Add the JSON export.',INPUT_TOO_LARGE:'The export is larger than 250,000 bytes.',INVALID_JSON:'The export is not valid UTF-8 JSON.',INVALID_SHAPE:'Use supported normalized Compose JSON; check services, mappings and resource definitions.',STRUCTURE_LIMIT:'The JSON exceeds the nesting or structure limits.',REPORT_LIMIT:'Too many review items. Compare a smaller complete project.',FILE_NOT_REGULAR:'Use an explicit local regular file.',INPUT_READ_FAILED:'Unable to read the local file.' },
    actions: {
      PROJECT_NAME_REVIEW:'Project name is missing or unresolved; confirm it on both hosts.', PROJECT_NAME_CHANGED:'Project name changed; check which concrete volumes and networks Compose selects.',
      RESOURCE_MISSING:'Logical resource missing at destination; verify deliberate removal or restore mapping.', RESOURCE_ADDED:'New logical resource at destination; verify its purpose.',
      PHYSICAL_NAME_REVIEW:'Concrete volume or network name is unresolved; verify the actual name.', VOLUME_PHYSICAL_NAME_CHANGED:'Concrete volume name changed. A new volume may be empty; verify data and mapping before switching.', NETWORK_PHYSICAL_NAME_CHANGED:'Concrete network name changed; verify network mapping and connectivity.',
      CONFIG_SECRET_REVIEW:'Verify this config or secret exists and is usable at destination; values are not checked.', RESOURCE_NAME_CHANGED:'Config or secret name changed; verify the binding.', EXTERNAL_RESOURCE_CHANGED:'External-resource status changed; verify the existing resource and ownership.', RESOURCE_DEFINITION_CHANGED:'Resource definition differs; review driver, options or input reference.',
      UNRESOLVED_FIELDS_REVIEW:'Contains unresolved variable markers; verify final configuration and private inputs locally.', DEPENDENCY_REFERENCE_UNRESOLVED:'A startup dependency is not in this snapshot; check scope and reference.', NETWORK_REFERENCE_UNRESOLVED:'A network reference is not defined in this snapshot; verify the network.',
      MOUNT_MAPPING_REVIEW:'Mount type or path needs manual review.', VOLUME_SOURCE_REVIEW:'Named volume source is absent or unresolved; check anonymous or external storage.', VOLUME_REFERENCE_UNRESOLVED:'Mount references a logical volume not defined in this snapshot.',
      SERVICE_MISSING:'Source service is absent at destination; verify intentional removal.', SERVICE_ADDED:'New service appears at destination; check why.', IMAGE_CHANGED:'Image reference changed; check version, compatibility and data migration.', PLATFORM_CHANGED:'Platform changed; verify images and native dependencies on the target architecture.', NETWORK_MODE_CHANGED:'Network mode changed; verify connectivity.', BUILD_CHANGED:'Build context or selected build metadata changed; make needed host files available.', PORTS_CHANGED:'Published port mapping differs; verify exposure and conflicts.', NETWORK_ATTACHMENTS_CHANGED:'Network attachments changed; verify service connectivity.', STARTUP_DEPENDENCIES_CHANGED:'Startup dependencies or conditions changed; check order and readiness.', HEALTHCHECK_CHANGED:'Health check configuration changed; verify actual readiness and dependent services.', ENVIRONMENT_INPUTS_CHANGED:'Environment key set or file reference changed; recheck private values separately.', CONFIG_SECRET_ATTACHMENTS_CHANGED:'Config or secret attachments changed; verify the bindings.', MOUNT_MISSING:'Source mount target is missing at destination; check data and required files.', MOUNT_ADDED:'New mount target at destination; verify its data source.', MOUNT_SOURCE_CHANGED:'Mount type or source changed; verify data or host-file mapping.', MOUNT_OPTIONS_CHANGED:'Mount access or selected options changed; check intended permissions and behavior.'
    },
  },
  ru: {
    title: 'Сравнение исходной и новой конфигураций', important: 'Важно', review: 'Проверить',
    summary: (a,b,n) => `Сервисы: исходных — ${a}, новых — ${b}. Пунктов проверки — ${n}.`,
    equal: 'В проверенных полях различий нет. Проверьте новый сервер отдельно.',
    note: 'Это сравнение конфигураций, а не доказательство восстановления томов, данных, ключей или приложения. Одинаковые имена не переносят данные. Значения переменных и произвольные параметры сервисов не сравниваются.',
    scope: { project: 'Проект', service: 'Сервис', mount: 'Сервис', volume: 'Том', network: 'Сеть', config: 'Конфигурация', secret: 'Секрет' }, mount: 'подключение',
    source: 'Исходная', destination: 'Новая',
    errors: { INPUT_REQUIRED:'Добавьте JSON.', INPUT_TOO_LARGE:'Размер JSON превышает 250 000 байт.', INVALID_JSON:'Не удалось прочитать JSON в UTF-8.', INVALID_SHAPE:'Нужен нормализованный Compose JSON. Проверьте сервисы, подключения и определения ресурсов.', STRUCTURE_LIMIT:'Слишком сложная или глубоко вложенная структура JSON.', REPORT_LIMIT:'Слишком много пунктов проверки. Сравните меньший целостный проект.', FILE_NOT_REGULAR:'Укажите обычный локальный файл.', INPUT_READ_FAILED:'Не удалось прочитать локальный файл.' },
    actions: {
      PROJECT_NAME_REVIEW:'Имя проекта отсутствует или не раскрыто. Уточните его на обоих хостах.', PROJECT_NAME_CHANGED:'Имя проекта изменилось. Проверьте, какие физические тома и сети выберет Compose.',
      RESOURCE_MISSING:'Логический ресурс отсутствует в новой конфигурации. Проверьте, что его удаление или замена запланированы.', RESOURCE_ADDED:'В новой конфигурации появился ресурс. Проверьте его назначение.',
      PHYSICAL_NAME_REVIEW:'Физическое имя тома или сети неизвестно. Уточните фактическое имя.', VOLUME_PHYSICAL_NAME_CHANGED:'Физическое имя тома изменилось. Новый том может оказаться пустым: проверьте данные и соответствие томов до переключения.', NETWORK_PHYSICAL_NAME_CHANGED:'Физическое имя сети изменилось. Проверьте соответствие сетей и связность.',
      CONFIG_SECRET_REVIEW:'Проверьте наличие и работоспособность конфигурации или секрета отдельно. Значения не проверяются.', RESOURCE_NAME_CHANGED:'Имя конфигурации или секрета изменилось. Проверьте привязку.', EXTERNAL_RESOURCE_CHANGED:'Признак внешнего ресурса изменился. Проверьте наличие ресурса и доступ к нему.', RESOURCE_DEFINITION_CHANGED:'Описание ресурса изменилось. Сверьте драйвер, параметры или источник.',
      UNRESOLVED_FIELDS_REVIEW:'Есть нераскрытые переменные. Сверьте итоговую конфигурацию и приватные значения у себя.', DEPENDENCY_REFERENCE_UNRESOLVED:'Ссылка на зависимость не найдена в этом JSON. Проверьте полноту экспорта и настройку.', NETWORK_REFERENCE_UNRESOLVED:'Сеть не определена в этом JSON. Проверьте её наличие.',
      MOUNT_MAPPING_REVIEW:'Тип подключения или путь нужно проверить вручную.', VOLUME_SOURCE_REVIEW:'Источник тома отсутствует или не раскрыт. Проверьте анонимный или внешний том.', VOLUME_REFERENCE_UNRESOLVED:'Подключение ссылается на том, которого нет в этом JSON.',
      SERVICE_MISSING:'Исходного сервиса нет в новой конфигурации. Проверьте, запланировано ли его удаление.', SERVICE_ADDED:'В новой конфигурации появился сервис. Проверьте его назначение.', IMAGE_CHANGED:'Ссылка на образ изменилась. Проверьте версию, совместимость и перенос данных.', PLATFORM_CHANGED:'Платформа изменилась. Проверьте образы и нативные зависимости для новой архитектуры.', NETWORK_MODE_CHANGED:'Сетевой режим изменился. Проверьте связность.', BUILD_CHANGED:'Изменился контекст сборки или её настройки. Подготовьте нужные файлы на новом хосте.', PORTS_CHANGED:'Публикация портов изменилась. Проверьте доступ извне и конфликты.', NETWORK_ATTACHMENTS_CHANGED:'Подключения к сетям изменились. Проверьте связность сервисов.', STARTUP_DEPENDENCIES_CHANGED:'Зависимости или условия запуска изменились. Проверьте порядок и готовность сервисов.', HEALTHCHECK_CHANGED:'Проверка готовности изменилась. Проверьте реальную готовность и зависимые сервисы.', ENVIRONMENT_INPUTS_CHANGED:'Набор переменных или ссылки на env-файлы изменились. Проверьте приватные значения отдельно.', CONFIG_SECRET_ATTACHMENTS_CHANGED:'Подключения конфигураций или секретов изменились. Проверьте привязки.', MOUNT_MISSING:'Исходной точки подключения нет в новой конфигурации. Проверьте данные и файлы.', MOUNT_ADDED:'В новой конфигурации появилась точка подключения. Проверьте источник данных.', MOUNT_SOURCE_CHANGED:'Тип или источник подключения изменились. Сверьте соответствие данных или файлов хоста.', MOUNT_OPTIONS_CHANGED:'Режим доступа или настройки подключения изменились. Проверьте права и поведение.'
    },
  },
};

function comparisonErrorMessage(code, locale = 'en') {
  const t = copy[locale] ?? copy.en;
  const side = code.startsWith('SOURCE_') ? 'SOURCE_' : code.startsWith('DESTINATION_') ? 'DESTINATION_' : '';
  const message = t.errors[code.slice(side.length)] ?? t.errors.INVALID_SHAPE;
  return side === 'SOURCE_' ? `${t.source}: ${message}` : side === 'DESTINATION_' ? `${t.destination}: ${message}` : message;
}

function comparisonText(report, locale = 'en') {
  const t = copy[locale] ?? copy.en;
  const pos = value => value === null ? '—' : `#${value}`;
  const lines = report.findings.map(f => {
    const scope = t.scope[f.scope];
    const location = f.scope === 'project' ? scope : `${scope} ${pos(f.source)} → ${pos(f.destination)}` + (f.scope === 'mount' ? ` · ${t.mount} ${pos(f.sourceItem)} → ${pos(f.destinationItem)}` : '');
    return `${f.priority === 'important' ? t.important : t.review}: ${location} · ${f.code}\n${t.actions[f.code]}`;
  });
  return [t.summary(report.sourceServices, report.destinationServices, lines.length), lines.length ? '' : t.equal, t.note, ...lines].filter(Boolean).join('\n\n');
}

function comparisonExample() {
  const fixture = (name, dir) => ({
    name, services: { db: { image:'postgres:17-alpine', volumes:[{type:'volume',source:'pgdata',target:'/var/lib/postgresql/data'}], networks:{private:null} },
      caddy: {image:'caddy:2-alpine',volumes:[{type:'bind',source:`/synthetic/${dir}/Caddyfile`,target:'/etc/caddy/Caddyfile',read_only:true},{type:'volume',source:'caddy_data',target:'/data'}],networks:{private:null}} },
    volumes:{pgdata:{name:`${name}_pgdata`},caddy_data:{name:`${name}_caddy_data`}},networks:{private:{name:`${name}_private`,internal:true}},
  });
  return [fixture('original-workspace','original-workspace'),fixture('new-workspace','new-workspace')];
}

export { MAX_COMPARE_BYTES, CompareError, compareComposeBytes, comparisonErrorMessage, comparisonText, comparisonExample };
