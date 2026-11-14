import { describe, expect, it } from 'vitest';
import { classifyGws, setsGwsCredentials } from './gws.js';

const kindOf = (command: string) => classifyGws(command)?.kind ?? null;

describe('classifyGws: recognising gws', () => {
  it.each([
    'gws drive files list',
    '/usr/local/bin/gws drive files list',
    'C:\\Tools\\gws.exe drive files list',
    'GWS.EXE drive files list',
    'gws.cmd drive files list',
    '"C:\\Program Files\\gws\\gws.exe" drive files list',
    'npx -y @googleworkspace/cli@0.22.5 drive files list',
    'npx.cmd --yes @googleworkspace/cli drive files list',
    'bunx @googleworkspace/cli drive files list',
    'pnpx @googleworkspace/cli drive files list',
    'pnpm dlx @googleworkspace/cli drive files list',
    'yarn dlx @googleworkspace/cli drive files list',
    'sudo gws drive files list',
    'FOO=1 gws drive files list',
    'FOO="a b" gws drive files list',
    'env -i HOME=/tmp gws drive files list',
    'nohup gws drive files list',
    'time -p gws drive files list',
  ])('reads %s as a gws read', (command) => {
    expect(classifyGws(command)).toMatchObject({ kind: 'read', service: 'drive', target: 'list' });
  });

  it.each([
    'ls',
    'echo gws',
    'grep gws notes.md',
    'grep -rn "gws" docs',
    'rg gws docs website',
    'gwsx drive files list',
    'my-gws drive files list',
    'npm install -g some-cli',
    'npx prettier --write .',
    'pnpm install',
  ])('ignores %s', (command) => {
    expect(classifyGws(command)).toBeNull();
  });
});

describe('classifyGws: reads', () => {
  it.each([
    'gws',
    'gws --help',
    'gws -h',
    'gws --version',
    'gws -V',
    'gws version',
    'gws drive',
    'gws drive --help',
    'gws drive files list --help',
    `gws gmail users messages list --params '{"q":"is:unread"}'`,
    `gws gmail users messages get --params '{"userId":"me","id":"m1"}'`,
    `gws gmail users getProfile --params '{"userId":"me"}'`,
    `gws drive files export --params '{"fileId":"f","mimeType":"text/plain"}' -o report.txt`,
    `gws drive permissions list --params '{"fileId":"f"}'`,
    `gws sheets spreadsheets values batchGet --params '{"spreadsheetId":"s"}'`,
    'gws admin-reports activities list',
    'gws drive:v2 files list',
    'gws --format=json drive files list',
    'gws --format json drive files list',
    'gws --dry-run drive files list',
    'gws drive --format json files list',
    'gws drive files list --format json --page-limit 5',
    'gws drive files list --api-version v2',
    'gws drive files list > files.json',
    'gws drive files list >> log.txt 2>/dev/null',
    'gws drive files list > files.json 2>',
    'gws gmail +read --id m1',
    'gws gmail +triage',
    'gws sheets +read --spreadsheet s --range A1:B2',
    'gws calendar +agenda',
    'gws workflow +standup-report',
    'gws wf +weekly-digest',
    'gws schema drive.files.list',
    'gws auth status',
  ])('%s is a read', (command) => {
    expect(kindOf(command)).toBe('read');
  });
});

describe('classifyGws: writes', () => {
  it.each([
    `gws gmail users drafts create --json '{"message":{"raw":"x"}}'`,
    `gws gmail users messages modify --params '{"userId":"me","id":"m1"}' --json '{"addLabelIds":["L1"]}'`,
    `gws gmail users messages trash --params '{"userId":"me","id":"m1"}'`,
    `gws drive files create --json '{"name":"Notes"}'`,
    `gws drive files copy --params '{"fileId":"f"}'`,
    `gws docs documents batchUpdate --params '{"documentId":"d"}' --json '{"requests":[]}'`,
    'gws docs +write --document d --text hello',
    'gws sheets +append --spreadsheet s --values a,b',
    'gws gmail +watch --project p',
    'gws events +subscribe --target t',
    'gws workflow +email-to-task --message-id m1',
    `gws tasks tasks insert --params '{"tasklist":"t"}' --json '{"title":"x"}'`,
    `gws calendar events watch --params '{"calendarId":"primary"}'`,
    'gws generate-skills',
    'gws gmail +send --to a@b.com --subject Hi --body Hello --draft',
    'gws gmail +reply --message-id m1 --body ok --draft',
    'gws gmail +reply-all --message-id m1 --body ok --draft',
    'gws gmail +forward --message-id m1 --to a@b.com --draft',
  ])('%s is a write', (command) => {
    expect(kindOf(command)).toBe('write');
  });
});

describe('classifyGws: sensitive', () => {
  it.each([
    `gws gmail users drafts send --json '{"id":"r1"}'`,
    `gws gmail users messages send --json '{"raw":"x"}'`,
    'gws gmail +send --to a@b.com --subject Hi --body Hello',
    'gws gmail +reply --message-id m1 --body ok',
    'gws gmail +reply-all --message-id m1 --body ok',
    'gws gmail +forward --message-id m1 --to a@b.com',
    'gws chat +send --space spaces/x --text hi',
    'gws workflow +file-announce --file f --space spaces/x',
    'gws drive files create --upload ./a.pdf',
    'gws drive files create --upload=./a.pdf',
    'gws drive +upload ./a.pdf',
    'gws script +push --script s',
    'gws calendar +insert --summary Meeting',
    `gws drive permissions create --params '{"fileId":"f"}' --json '{"role":"writer","type":"anyone"}'`,
    `gws drive permissions update --params '{"fileId":"f","permissionId":"p"}'`,
    `gws drive files delete --params '{"fileId":"f"}'`,
    'gws drive files emptyTrash',
    `gws gmail users messages batchDelete --json '{"ids":["m1"]}'`,
    `gws people people deleteContact --params '{"resourceName":"people/c1"}'`,
    `gws calendar events insert --params '{"calendarId":"primary"}'`,
    `gws calendar events patch --params '{"calendarId":"primary","eventId":"e"}'`,
    `gws calendar acl insert --params '{"calendarId":"primary"}'`,
    `gws calendar calendars clear --params '{"calendarId":"primary"}'`,
    `gws gmail users settings forwardingAddresses create --json '{"forwardingEmail":"x@y.com"}'`,
    `gws gmail users settings filters create --json '{}'`,
    `gws chat spaces messages create --params '{"parent":"spaces/x"}'`,
    `gws chat spaces members create --params '{"parent":"spaces/x"}'`,
    `gws admin:directory_v1 users update --params '{"userKey":"u"}'`,
    `gws groupssettings:v1 groups patch --params '{"groupUniqueId":"g"}'`,
    'gws iam:v1 projects serviceAccounts keys create',
    `gws drive --format json files delete --params '{"fileId":"f"}'`,
    `gws drive files delete --dry-run --params '{"fileId":"f"}'`,
    'gws gmail +send --to a@b.com --draft --attach ./a.pdf',
    'gws gmail +send --to a@b.com --draft -a ./a.pdf',
    'gws gmail +send --to a@b.com --body=--draft',
    'gws chat +send --space spaces/x --text hi --draft',
  ])('%s is sensitive', (command) => {
    expect(kindOf(command)).toBe('sensitive');
  });
});

describe('classifyGws: fails safe', () => {
  it.each([
    'gws gmail +unknown-helper',
    'gws --verbose gmail users messages list',
    'gws drive --foo files list',
    'gws $(echo gmail) users messages list',
    'gws gmail users messages list --params $P',
    'gws "$SVC" files list',
    'gws drive files list --params "unterminated',
    'gws drive files list ~/out.json',
    'xargs gws gmail +send',
    'bash -c "gws drive files delete --params x"',
    'sudo -u bob gws drive files list',
    'npx -p @googleworkspace/cli gws drive files list',
    'npm exec @googleworkspace/cli -- drive files list',
  ])('%s is sensitive', (command) => {
    expect(kindOf(command)).toBe('sensitive');
  });
});

describe('classifyGws: credentials', () => {
  it.each([
    'gws auth export',
    'gws auth export --unmasked',
    'gws auth login -s gmail,drive,docs --readonly',
    'gws auth setup',
    'gws auth logout',
    'gws auth',
    'gws --dry-run auth export',
    'gws --format json auth export',
    'gws --verbose auth export',
    'npx -y @googleworkspace/cli auth export',
  ])('%s is a credentials command', (command) => {
    expect(kindOf(command)).toBe('credentials');
  });
});

describe('classifyGws: service and target', () => {
  it('names the helper for a send', () => {
    expect(classifyGws('gws gmail +send --to a@b.com')).toMatchObject({ kind: 'sensitive', service: 'gmail', target: '+send' });
  });

  it('names the method and drops the API version', () => {
    expect(classifyGws('gws Gmail:v1 users messages list')).toMatchObject({ kind: 'read', service: 'gmail', target: 'list' });
  });

  it('names the auth subcommand', () => {
    expect(classifyGws('gws auth export')).toMatchObject({ kind: 'credentials', target: 'auth export' });
  });

  it('gives a reason for every sensitive command', () => {
    expect(classifyGws('gws drive files create --upload a.pdf')?.reason).toBe('uploads a local file');
    expect(classifyGws('gws gmail +nope')?.reason).toBe('is a gws helper Mercury does not know');
    expect(classifyGws('gws $(echo gmail) +send')?.reason).toBe('Mercury could not read this gws command');
  });
});

describe('setsGwsCredentials', () => {
  it.each([
    'GOOGLE_WORKSPACE_CLI_TOKEN=x gws drive files list',
    'export GOOGLE_APPLICATION_CREDENTIALS=k.json',
    'set GOOGLE_WORKSPACE_CLI_CONFIG_DIR=C:\\x',
    'set google_workspace_cli_token=x',
    '$env:GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="x"',
    'env GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file gws auth status',
    'setx GOOGLE_WORKSPACE_CLI_TOKEN abc',
    `powershell -c "[Environment]::SetEnvironmentVariable('GOOGLE_WORKSPACE_CLI_TOKEN', 'x')"`,
    'powershell -c "Write-Output $env:GOOGLE_WORKSPACE_CLI_TOKEN"',
  ])('catches %s', (command) => {
    expect(setsGwsCredentials(command)).toBe(true);
  });

  it.each([
    'grep -r GOOGLE_WORKSPACE_CLI_TOKEN docs',
    'MY_GOOGLE_WORKSPACE_CLI_TOKEN=1 node app.js',
    'gws drive files list',
    'FOO=1 gws drive files list',
  ])('leaves %s alone', (command) => {
    expect(setsGwsCredentials(command)).toBe(false);
  });
});
