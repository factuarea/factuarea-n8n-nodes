#!/usr/bin/env python3
"""Run only the new installed native-host group in a private network-none container."""
import hashlib, json, os, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT.parent / 'runtime-evidence/resume-20261010'
runtime_name = sys.argv[1] if len(sys.argv) > 1 else 'dev2n8n-installedBatch82'
if not runtime_name.startswith('dev2n8n-installedBatch82') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in runtime_name):
    raise SystemExit('Runtime name must be a plain dev2n8n-installedBatch82-prefixed private directory.')
RUNTIME = EVIDENCE / runtime_name
IMAGE = 'docker.n8n.io/n8nio/n8n@sha256:526daa38b68e923cc00c5280d18b4da5d489f115a73bdbf3b8e452b184197a9a'
NAME = 'dev2n8n-installed-batch82'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def run(name, argv, cwd=None):
    p = RUNTIME / (name + '.log')
    with p.open('w') as out:
        result = subprocess.run(argv, cwd=cwd, stdout=out, stderr=subprocess.STDOUT)
    p.chmod(0o600)
    print(name, 'exit', result.returncode, flush=True)
    if result.returncode:
        print('Private failure evidence:', p, flush=True)
        raise SystemExit(result.returncode)
    return {'argv': argv, 'cwd': str(cwd or ROOT), 'exit_code': result.returncode, 'log': str(p), 'sha256': sha(p)}

RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
RUNTIME.chmod(0o700)
if (RUNTIME / 'dev2n8n-home/.n8n/database.sqlite').exists():
    raise SystemExit('Use a fresh explicitly named private run directory; existing native host data is preserved.')
archive = ROOT / 'n8n-nodes-factuarea-0.1.2.tgz'
prior = json.loads((EVIDENCE / 'ecosystem-meta-native.json').read_text())
assert sha(archive) == prior['artifact_pins']['n8n_package']['pin']['sha256']
def verify_previous_pins():
    roots = {'n8n': ROOT, 'make': ROOT.parent.parent/'app/integrations/crm/make-application', 'zapier': ROOT.parent.parent/'app/integrations/crm/zapier-application'}
    count = 0
    for platform, pins in prior['source_pins'].items():
        for pin in pins:
            assert sha(roots[platform]/pin['path']) == pin['sha256'], pin['path']
            count += 1
    for group, pins in prior['artifact_pins'].items():
        platform = group.split('_')[0]
        if isinstance(pins, dict): pins = [pins['pin']]
        for pin in pins:
            assert sha(roots[platform]/pin['path']) == pin['sha256'], pin['path']
            count += 1
    for pin in prior['leased_external_document_pins']:
        assert sha(Path(pin['path'])) == pin['sha256'], pin['path']
        count += 1
    assert count == 495
    return count
verify_previous_pins()
shutil.copyfile(archive, RUNTIME / archive.name)
shutil.copyfile(ROOT / 'docs/recipes/web-lead-follow-up.workflow.json', RUNTIME / 'original.workflow.json')
home = RUNTIME / 'dev2n8n-home'
nodes = home / '.n8n/nodes'
nodes.mkdir(mode=0o700, parents=True, exist_ok=True)
(nodes / 'package.json').write_text(json.dumps({'name':'dev2n8n-installed-private-fixture','private':True}) + '\n')
checks = [run('actual-offline-package-install', ['npm','install','--offline','--ignore-scripts','--legacy-peer-deps','--no-audit','--no-fund','--cache',str(RUNTIME/'dev2n8n-npm-cache'),'--prefix',str(nodes),str(RUNTIME / archive.name)])]
tls = RUNTIME / 'tls'; tls.mkdir(mode=0o700, exist_ok=True)
checks.append(run('private-loopback-ca', ['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',str(tls/'key.pem'),'-out',str(tls/'cert.pem'),'-subj','/CN=api.factuarea.com','-addext','subjectAltName=DNS:api.factuarea.com']))
(tls / 'key.pem').chmod(0o600)
env = RUNTIME / 'private.env'
env.write_text('\n'.join([
    'DEV2N8N_RUNTIME=/dev2n8n-runtime',
    'N8N_USER_FOLDER=/dev2n8n-runtime/dev2n8n-home',
    'N8N_HOST=127.0.0.1','N8N_LISTEN_ADDRESS=127.0.0.1','N8N_PORT=17282',
    'N8N_ENCRYPTION_KEY=' + os.urandom(32).hex(),
    'N8N_DIAGNOSTICS_ENABLED=false','N8N_VERSION_NOTIFICATIONS_ENABLED=false','N8N_TEMPLATES_ENABLED=false',
    'N8N_PERSONALIZATION_ENABLED=false','N8N_LICENSE_AUTO_RENEW_ENABLED=false','N8N_SECURE_COOKIE=false',
    'N8N_COMMUNITY_PACKAGES_ENABLED=true','N8N_UNVERIFIED_PACKAGES_ENABLED=true',
    'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true','GENERIC_TIMEZONE=Europe/Madrid','TZ=Europe/Madrid',
    'NODE_EXTRA_CA_CERTS=/dev2n8n-runtime/tls/cert.pem',
]) + '\n'); env.chmod(0o600)
checks.append(run('installed-native-host', ['docker','run','--rm','--name',NAME,'--user',str(os.getuid())+':'+str(os.getgid()),'--network','none','--cpus','2','--memory','2g',
    '--add-host','api.factuarea.com:127.0.0.1','--env-file',str(env),
    '--mount','type=bind,src='+str(RUNTIME)+',dst=/dev2n8n-runtime',
    '--mount','type=bind,src='+str(ROOT/'test/installedBatch82')+',dst=/dev2n8n-tests,readonly',
    '--entrypoint','node',IMAGE,'--test','--test-concurrency=1','/dev2n8n-tests/installed.test.mjs']))
private_mount = 'type=bind,src='+str(RUNTIME)+',dst=/dev2n8n-runtime'
checks.append(run('native-entities-export', ['docker','run','--rm','--name',NAME+'-export','--user',str(os.getuid())+':'+str(os.getgid()),'--network','none','--env-file',str(env),'--mount',private_mount,IMAGE,'export:entities','--outputDir=/dev2n8n-runtime/dev2n8n-native-entities','--includeExecutionHistoryDataTables']))
checks.append(run('native-pairing-observation', ['docker','run','--rm','--name',NAME+'-observe','--user',str(os.getuid())+':'+str(os.getgid()),'--network','none','--env-file',str(env),'--mount',private_mount,'--mount','type=bind,src='+str(ROOT/'scripts/installedBatch82')+',dst=/dev2n8n-scripts,readonly','--entrypoint','node',IMAGE,'/dev2n8n-scripts/export-observations.cjs']))
out = {'kind':'new-native-installed-n8n-host-proof','engine':{'version':'2.42.6','image':IMAGE},'runtime':str(RUNTIME),'checks':checks,'previous_495_pins_untouched':True,
    'native_import_and_execution_result':json.loads((RUNTIME/'installed-result.json').read_text()),'boundaries':{'network':'none','database':'new private n8n SQLite only','external_activation':False,'backend_runtime':False,'previous_plugin_suites_rerun':False}}
out['previous_pin_count_verified_after_execution'] = verify_previous_pins()
out['native_pairing_observation'] = json.loads((RUNTIME/'native-pairing-observation.json').read_text())
p = EVIDENCE / 'ecosystem-n8n-installed-batch82.json'
p.write_text(json.dumps(out,indent=2,ensure_ascii=False)+'\n');p.chmod(0o600)
print('Native installed proof:', p, 'SHA256', sha(p), flush=True)
