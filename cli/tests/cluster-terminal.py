"""Run both cluster workflows with a fake cluster, preserving the configuration draft."""
from terminal import Session, binary
import json
import os
from pathlib import Path
import subprocess
import tempfile

mock = r'''#!/usr/bin/env python3
import sys,json,time,os
from pathlib import Path
a=sys.argv[1:]
with open('trace','a') as f:f.write(json.dumps([Path(sys.argv[0]).name,*a])+'\n')
if Path(sys.argv[0]).name=='helm':
 if 'version' in a:print('fixture');sys.exit()
 if os.environ.get('KRAB_TEST_HELM_HANG'):time.sleep(30)
 v=json.loads(Path(a[a.index('--values')+1]).read_text())
 assert v['cache']['forceRefresh']
 Path('selected').write_text(v['nodeSelector']);sys.exit()
if 'current-context' in a or 'get-contexts' in a:print('test-context');sys.exit()
selector=a[a.index('--selector')+1] if '--selector' in a else Path('selected').read_text()
names=['worker-a'] if 'hostname=host-a' in selector else ['worker-a','worker-b']
identities=[{'name':n,'uid':'uid-'+n,'machineID':'machine-'+n,'bootID':'boot-'+n} for n in names]
if 'nodes' in a:
 print(json.dumps({'kind':'NodeList','items':[{'metadata':{'name':n,'uid':'uid-'+n,'labels':{'kubernetes.io/hostname':'host-a' if n=='worker-a' else 'host-b'}},'status':{'nodeInfo':{'machineID':'machine-'+n,'bootID':'boot-'+n}}} for n in names]}));sys.exit()
def probe(status):return {'status':status,'reason':'Fixture: '+status}
print(json.dumps({'kind':'krab-cluster-precheck','schemaVersion':2,'scope':{'nodeSelector':(selector+',' if selector else '')+'kubernetes.io/os=linux','nodes':identities},'nodes':[{'nodeName':n,'report':{'kind':'krab-node-precheck','schemaVersion':2,'node':{'architecture':'amd64','kernel':'6.12','machineID':'machine-'+n,'bootID':'boot-'+n,'checkerVersion':os.environ['KRAB_TEST_CHECKER_VERSION'],'checkedAtUnixSeconds':int(time.time())},'checks':{'kvm':probe('yes' if n=='worker-a' else 'no'),'tdx':probe('no'),'snp':probe('no'),'se':probe('no'),'iommufd':probe('no'),'erofs':probe('no')},'gpus':{'present':probe('no'),'nvidia':probe('no'),'cc':probe('no'),'ppcie':probe('no'),'nvswitch':probe('no'),'devices':[]}}} for n in names]}))
'''

with tempfile.TemporaryDirectory(prefix='krab-cluster-terminal-') as directory:
    root=Path(directory)
    (root/'bin').mkdir()
    for name in ('helm','kubectl'):
        path=root/'bin'/name
        path.write_text(mock)
        path.chmod(0o755)
    (root/'fake-kubeconfig').write_text('fixture')
    subprocess.run([binary,'init','--non-interactive'],cwd=directory,check=True,capture_output=True)
    original=(root/'krab.yaml').read_bytes()
    checker_version=subprocess.check_output([binary,'--version'],text=True).strip().split()[-1]
    environment={'PATH':str(root/'bin')+os.pathsep+os.environ['PATH'],
                 'KRAB_TEST_CHECKER_VERSION':checker_version}
    session=Session(directory,[],extra_env=environment)
    session.key(b'\r')
    session.key(b'fake-kubeconfig\r')
    session.wait_for(b'Select Kubernetes context')
    session.key(b'\r')
    session.wait_for(b'Select Linux node')
    session.key(b'\r')
    session.wait_for(b'Review and run')
    session.key(b'\r')
    session.wait_for(b'Pre-check reports')
    session.key(b'\x1b')
    # Second menu item runs cluster conformance, defaulting to basic KVM checks.
    session.key(b'\x1b[B')
    session.key(b'\r')
    start=len(session.transcript)
    session.key(b'\r')
    session.wait_for(b'Select Kubernetes context',start)
    session.key(b'\r')
    session.wait_for(b'Node scope',start)
    session.key(b'\r')
    session.wait_for(b'Conformance requirements',start)
    session.key(b'\r')
    session.key(b'\r')
    session.wait_for(b'worker-b',start)
    session.wait_for(b'Failed/error nodes',start)
    session.key(b'e')
    session.key(b'verdict.json\r')
    session.wait_for(b'Saved verdict.json',start)
    verdict=json.loads((root/'verdict.json').read_text())
    assert verdict['failedNodes']==1
    assert verdict['nodes'][1]['nodeName']=='worker-b'
    session.key(b'\x1b')
    session.key(b'q')
    assert not session.finish()
    assert (root/'krab.yaml').read_bytes()==original
    trace=(root/'trace').read_text()
    assert 'hostname=host-a' in trace
    # Escape cancels the local collection process group without discarding the editor.
    session=Session(directory,[],extra_env={**environment,'KRAB_TEST_HELM_HANG':'1'})
    session.key(b'\r')
    session.key(b'\r')
    session.wait_for(b'Select Kubernetes context')
    session.key(b'\r')
    session.wait_for(b'Select Linux node')
    session.key(b'\r')
    session.wait_for(b'Review and run')
    session.key(b'\r')
    session.wait_for(b'Collecting fresh host probes')
    session.key(b'\x1b')
    session.wait_for(b'Collection cancelled')
    session.key(b'\x1b')
    session.key(b'q')
    assert not session.finish()
    assert (root/'krab.yaml').read_bytes()==original
print('Node pre-check, cluster conformance, failed-node details, export, and editor preservation passed.')
