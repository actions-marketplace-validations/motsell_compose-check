# MOTSELL Compose Check

A small, offline readiness checklist for planning the migration of **your own** Docker Compose project. It reads normalized JSON and reports review cues for persistent data, backup restoration, port mappings, host files, startup dependencies, deployment architecture and external resources. It is not a Compose validator, security scanner, backup utility or deployment tool.

## English

Requires a supported Node.js LTS release (22 or newer). No runtime dependencies. No daemons or credentials.

Install with npm:

```sh
npm install -g @motsell/compose-check
```

Run from a source checkout without installing the package:

```sh
node bin/compose-check.mjs --file examples/compose.json
docker compose config --format json | node bin/compose-check.mjs --json
```

The installed command accepts the same arguments:

```sh
motsell-compose-check --file ./normalized-compose.json --json
docker compose config --format json | motsell-compose-check
```

The `docker compose` command is run by you, not by this tool. Docker Compose may resolve environment variables and include sensitive values in its output. Prefer piping directly; do not share normalized JSON or store it in public locations. Use the tool only with configurations you are authorized to review.

### Input and output

- UTF-8 normalized `docker compose config --format json` output from stdin, or an explicitly named regular file with `--file PATH`. Do not use `--no-normalize`. The checker does not accept YAML, URLs, symlinks to files, pipes as file arguments, or other special files. For actual piped input, omit `--file`.
- Input limit: 250,000 **bytes**, 1–80 services, ordinary Compose service names of up to 64 characters. If legacy string mappings or incomplete normalized mappings appear, the checker reports review cues; it is not an exhaustive schema validator.
- `--json` emits a JSON report on stdout: `schemaVersion`, `services`, `possibleDatabases`, `publishedPortEntries`, and findings with stable `code`, `priority` and `service` fields. `service` is the 1-based ordinal in parsed service property order (as returned by JavaScript `Object.keys`; integer-like keys first), or `null` for project-wide cues. Direct names are not returned. Treat `important` and `review` as checklist priorities, not established vulnerabilities, failed backups, or confirmed exposure. For invalid input, stdout is empty; `--json` emits a fixed `{ "schemaVersion": 1, "error": "CODE" }` object on stderr.
- `--lang ru` selects the Russian human-readable report; JSON codes remain language-independent. `--help` lists options.
- Exit `0`: input analyzed with no `important` findings; `review` findings may remain. Exit `1`: one or more `important` findings. Exit `2`: invalid arguments, unreadable input, or invalid JSON/configuration. A zero exit code does not certify readiness.

### What it does not do

The tool never starts Docker, runs shell commands, connects to a host, checks port reachability, downloads images, reads `.env` or other referenced files, creates backups, changes files, transmits input or collects telemetry. It only reads the input explicitly provided. Reports contain fixed messages/codes and counters, not source paths, service names, parsed environment values, image references or raw parse errors. The program cannot determine whether the filesystem you chose is locally mounted or backed by remote storage.

Database/cache detection and port cues are conservative heuristics based on a few common names, images and port numbers. An apparent mount may not cover the real data directory; a published port is not a reachability test. Review the findings, verify application requirements, test restoration and inspect the target environment separately.

Related documentation: [Docker Compose quick-start and tested starter](https://motsell.com/en/vps-docker?utm_source=github&utm_medium=repository&utm_campaign=compose_check_20261119&utm_content=readme#docker-quick-start) and the [browser-based checklist](https://motsell.com/tools/motsell-compose-check.html?utm_source=github&utm_medium=repository&utm_campaign=compose_check_20261119&utm_content=browser_tool). The CLI works offline without either link.

Moving a Next.js app from Vercel? [Plan a VPS migration](https://motsell.com/en/guides/vps-for-websites?utm_source=github&utm_medium=repository&utm_campaign=vercel_migration_20261120&utm_content=compose_readme_en), including managed services that a Compose checklist cannot account for automatically.

### Optional GitHub Action for a manual migration review

In a manually started (`workflow_dispatch`) job on a standard Linux runner, after your trusted source checkout, add this step. Replace the placeholder with the full commit SHA of the reviewed Action release. The file must be a regular, workspace-relative normalized JSON file; symlinks, URL and parent-directory paths are not accepted.

```yaml
- uses: motsell/compose-check@<reviewed-release-commit-sha>
  with:
    json_file: migration/compose.normalized.json
    fail_on_important: 'false'
```

Use a non-secret fixture or prepare the file in a separate trusted step. Do not check resolved secrets into the repository, print normalized JSON, upload it as an artifact, or pass it through workflow inputs. Avoid running this job on untrusted PRs or concurrently modifying the workspace. Use read-only repository permissions and avoid persisting checkout credentials. The Action itself does not execute Docker, request a token, send files, install packages, or call remote services; it wraps the existing CLI and prints only its fixed checklist messages and counters. Important cues are advisory by default. Set `fail_on_important: 'true'` to opt into a nonzero result for important cues; invalid input and checker failures always fail. This is not a deploy gate or security certification.

## Русский

Локальная предварительная проверка готовности **вашего** Docker Compose-проекта к переносу. Подсказки охватывают тома и резервные копии, публикацию портов, зависимости от файлов хоста, порядок запуска, архитектуру и внешние ресурсы. Это не валидатор спецификации Compose, не аудит безопасности и не средство миграции.

Нужна поддерживаемая LTS-версия Node.js (22 или новее). Установки дополнительных зависимостей не требуется.

Из каталога локального релиза:

```sh
node bin/compose-check.mjs --file examples/compose.json --lang ru
docker compose config --format json | node bin/compose-check.mjs --json
```

Команду Docker Compose запускает сам пользователь; она может подставить значения окружения и включить чувствительные данные в JSON. Предпочтительнее передавать вывод по каналу stdin, не сохранять его в публичных местах и не отправлять третьим лицам. Проверяйте только конфигурации, к которым у вас есть разрешённый доступ.

- Ввод: нормализованный JSON в UTF-8 через stdin или обычный явно указанный файл (`--file PATH`). Не используйте `--no-normalize`. YAML, URL, символические ссылки и специальные файлы не поддерживаются.
- Лимиты: 250 000 байт, 1–80 сервисов, обычные имена Compose длиной до 64 символов.
- `--lang ru`: русский текст. `--json`: машиночитаемый отчёт со стабильными кодами, важностью (`important` / `review`) и порядковым номером сервиса (начиная с 1, `null` — замечание ко всему проекту). Имена сервисов, пути, значения секретов не печатаются.
- Код выхода `0` — анализ завершён без важных подсказок; `review` при этом возможны. `1` — есть важные подсказки. `2` — некорректный ввод, аргументы или ошибка чтения. При `--json` ошибка возвращается в stderr. Нулевой код не гарантирует успешный перенос.
- Инструмент не запускает Docker или другие процессы, не читает `.env` и упомянутые в JSON файлы, не проверяет доступность портов, не изменяет файлы и не отправляет телеметрию. Базы и кеши определяются эвристически; результат нужно проверить вручную, в том числе реальным восстановлением резервной копии.

GitHub Action — необязательная обёртка CLI для ручного запуска (`workflow_dispatch`) в доверенной рабочей среде. Передаётся только путь к уже подготовленному нормализованному JSON внутри workspace, не содержимое файла. Не публикуйте секреты в репозитории, логах или артефактах. По умолчанию важные подсказки не останавливают job; ошибка ввода или проверки всегда останавливает. Пример и настройки приведены в английском разделе выше.

Переезжаете с Vercel? [Гайд по переносу Next.js на VPS](https://motsell.com/ru/guides/vps-dlya-saita?utm_source=github&utm_medium=repository&utm_campaign=vercel_migration_20261120&utm_content=compose_readme_ru) дополнительно разбирает управляемые сервисы, которые Compose не переносит автоматически.

## License / Лицензия

MIT. See [LICENSE](LICENSE).

