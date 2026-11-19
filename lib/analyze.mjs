import { isIP } from 'node:net';

export const MAX_INPUT_BYTES = 250_000;
export const MAX_SERVICES = 80;
const dataPorts = new Set([3306, 5432, 6379, 11211, 27017]);

export class InputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownService = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const resolvedString = value => typeof value === 'string' && value.trim() !== '' && !value.includes('${');
const mappingArray = value => value == null || Array.isArray(value) && value.every(item => typeof item === 'string' || isObject(item));

function databaseService(name, service) {
  const image = typeof service.image === 'string' ? service.image.split(/[/:@]/).join(' ') : '';
  return /(?:^|[\s_-])(?:postgres(?:ql)?|mysql|mariadb|redis|valkey|mongo(?:db)?|memcached)(?:$|[\s_-])/i
    .test(name + ' ' + image);
}

function loopback(address) {
  const version = isIP(address ?? '');
  if (version === 4) return address.startsWith('127.');
  if (version !== 6) return false;
  try { return new URL(`http://[${address}]/`).hostname === '[::1]'; } // Parse only; no request.
  catch { return false; }
}

function validPortTarget(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 1 && number <= 65535;
}

export function parseCompose(bytes) {
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InputError('INVALID_JSON');
  }
}

// Intentionally a small set of migration heuristics, not a Compose schema validator.
// It does not open files, resolve variables, run Docker, probe hosts or retain input.
export function analyze(config) {
  if (!isObject(config) || !isObject(config.services)) throw new InputError('INVALID_CONFIG');
  const services = Object.entries(config.services);
  if (!services.length || services.length > MAX_SERVICES ||
      services.some(([name, service]) => !knownService.test(name) || !isObject(service))) {
    throw new InputError('INVALID_SERVICES');
  }

  const findings = [];
  let publishedPortEntries = 0;
  let possibleDatabases = 0;
  for (const [index, [name, service]] of services.entries()) {
    if (!mappingArray(service.ports) || !mappingArray(service.volumes)) throw new InputError('INVALID_MAPPINGS');
    const serviceIndex = index + 1;
    const add = (code, priority = 'review') => findings.push({ code, priority, service: serviceIndex });
    const ports = service.ports ?? [];
    const mounts = service.volumes ?? [];
    const database = databaseService(name, service);

    if (mounts.some(mount => typeof mount === 'string' || !resolvedString(mount.type) ||
        !resolvedString(mount.target) || (mount.type === 'bind' && !resolvedString(mount.source)) ||
        (mount.type === 'volume' && mount.source != null && !resolvedString(mount.source)) ||
        (mount.read_only != null && typeof mount.read_only !== 'boolean'))) {
      add('MOUNT_MAPPING_REVIEW');
    }
    if (database) {
      possibleDatabases += 1;
      const persistentMount = mounts.some(mount => isObject(mount) && (mount.type === 'volume' || mount.type === 'bind') &&
          resolvedString(mount.source) && resolvedString(mount.target) && (mount.read_only == null || mount.read_only === false));
      if (persistentMount) add('DATA_RESTORE_REVIEW');
      else add('DATA_MOUNT_NOT_FOUND', 'important');
    } else if (mounts.some(mount => isObject(mount) && mount.type === 'volume')) {
      add('VOLUME_BACKUP_REVIEW');
    }
    if (mounts.some(mount => isObject(mount) && mount.type === 'bind')) add('BIND_MOUNT_REVIEW');

    publishedPortEntries += ports.length;
    let unresolvedPort = false;
    let dataPort = false;
    for (const port of ports) {
      if (typeof port === 'string' || !validPortTarget(port.target) ||
          (port.host_ip != null && port.host_ip !== '' && (typeof port.host_ip !== 'string' || isIP(port.host_ip) === 0))) {
        unresolvedPort = true;
        continue;
      }
      if (port.published != null && ((!['number', 'string'].includes(typeof port.published)) ||
          !/^[0-9]+(?:-[0-9]+)?$/.test(String(port.published)))) unresolvedPort = true;
      if (!loopback(port.host_ip) && (database || dataPorts.has(Number(port.target)))) dataPort = true;
    }
    if (dataPort) add('DATA_PORT_PUBLICATION_REVIEW', 'important');
    if (unresolvedPort) add('PORT_MAPPING_REVIEW');

    if (service.build) add('BUILD_CONTEXT_REVIEW');
    if (service.platform) add('PLATFORM_REVIEW');
    if (service.network_mode === 'host') add('HOST_NETWORK_REVIEW');
    if ((Array.isArray(service.depends_on) || isObject(service.depends_on)) && Object.keys(service.depends_on).length) {
      add('DEPENDENCY_REVIEW');
    }
    if (service.env_file && (!Array.isArray(service.env_file) || service.env_file.length)) add('ENV_FILE_REVIEW');
  }

  for (const [key, code] of [
    ['volumes', 'EXTERNAL_VOLUMES_REVIEW'], ['networks', 'EXTERNAL_NETWORKS_REVIEW'],
    ['secrets', 'EXTERNAL_SECRETS_REVIEW'], ['configs', 'EXTERNAL_CONFIGS_REVIEW']
  ]) {
    if (isObject(config[key]) && Object.values(config[key]).some(item => isObject(item) && item.external === true)) {
      findings.push({ code, priority: 'review', service: null });
    }
  }
  if (['configs', 'secrets'].some(key => isObject(config[key]) && Object.values(config[key]).some(item =>
      isObject(item) && (Object.hasOwn(item, 'file') || Object.hasOwn(item, 'environment'))))) {
    findings.push({ code: 'CONFIG_INPUT_REVIEW', priority: 'review', service: null });
  }

  return {
    schemaVersion: 1,
    services: services.length,
    possibleDatabases,
    publishedPortEntries,
    findings: findings.sort((a, b) => Number(b.priority === 'important') - Number(a.priority === 'important'))
  };
}
