"""Build/check the user distribution; no dependency on external ZIP libraries.

Developer tools and tests stay in Git, never in the user ZIP. No obfuscation,
passwords, executable bundling, or antivirus exclusions are used.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / 'downloads/igor-client-finder.zip'
PREFIX = 'igor-client-finder/'
FILES = [
    'README.md', 'SOURCES.md', 'package.json', 'package-lock.json',
    'start.cmd', 'start-audit.cmd', 'audit-base.cmd', 'test-audit.cmd', 'diagnose-sources.cmd', 'report-base.cmd',
    'scripts/bootstrap-audit.mjs', 'scripts/diagnose-sources.mjs',
    'src/cli.mjs', 'src/config.mjs', 'src/model.mjs', 'src/network.mjs', 'src/run.mjs',
    'src/audit/browser.mjs', 'src/audit/cli.mjs', 'src/audit/contacts.mjs',
    'src/audit/diagnostics.mjs', 'src/audit/matching.mjs', 'src/audit/overture.mjs',
    'src/audit/process.mjs', 'src/audit/run.mjs', 'src/audit/saved-base.mjs', 'src/audit/prospects.mjs', 'src/audit/report-only.mjs',
]


def payload():
    result = {}
    for name in FILES:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Expected regular source file: {name}')
        # Git for Windows may check text out as CRLF. The distribution uses LF
        # consistently; never alter any other content during comparison/build.
        result[name] = path.read_bytes().replace(b'\r\n', b'\n')
    package = json.loads(result['package.json'])
    for key in ['test', 'check']:
        package['scripts'].pop(key, None)
    result['package.json'] = (json.dumps(package, ensure_ascii=False, indent=2) + '\n').encode()
    for name in ['README.md', 'SOURCES.md']:
        text = result[name].decode('utf-8')
        for dev_doc in ['OVERTURE-NETWORK.md', 'VALIDATION.md', 'AGENTS.md']:
            text = text.replace(f']({dev_doc})', f'](https://github.com/Igor45-ziko/igor-client-finder/blob/main/{dev_doc})')
        if name == 'README.md':
            text = text.split('## Проверки для Codex')[0] + '''## Полные исходники и тесты

Разработческие проверки npm run check / npm test доступны в полном репозитории,
а не в этом пользовательском ZIP. Версия программы указана в package.json.
https://github.com/Igor45-ziko/igor-client-finder

Файл ARCHIVE-CONTENTS.sha256 перечисляет содержимое и контрольные суммы.
Это проверка целостности, а не доказательство отсутствия вредоносного кода.
'''
        result[name] = text.encode('utf-8')
    result['ARCHIVE-CONTENTS.sha256'] = ''.join(
        f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(result.items())
    ).encode('utf-8')
    return result


def check(expected):
    with zipfile.ZipFile(ARCHIVE) as archive:
        assert len(archive.namelist()) == len(expected), 'Extra or duplicate entries'
        assert set(archive.namelist()) == {PREFIX + name for name in expected}, 'Unexpected file list'
        assert archive.testzip() is None, 'CRC error'
        for name, data in expected.items():
            assert archive.read(PREFIX + name) == data, f'Source mismatch: {name}'
    print(f'User ZIP verified: {len(expected)} files; SHA256 {hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    expected = payload()
    if '--check' not in sys.argv:
        ARCHIVE.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(expected.items()):
                info = zipfile.ZipInfo(PREFIX + name, date_time=(2026, 10, 26, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
    check(expected)
