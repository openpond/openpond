"""Durable serial editing session used by a credential-free remote tensor process."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import time

from ..wire import canonical_json, canonical_sha256, validate
from ..weight_space_programming import verify_weight_space_request, verify_weight_space_command_result
from .artifacts import require, read_json, file_hash
from .weight_space_tensors import TensorWorkspace, tensor_hash


def atomic_json(path, value):
    temporary = path.with_suffix('.pending')
    require(not path.is_symlink() and not temporary.is_symlink(), 'weight_space_journal_path')
    with temporary.open('wb') as handle:
        handle.write(canonical_json(value).encode())
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class WeightSpaceSession:
    def __init__(self, snapshot, request, *, session_id, runtime_hash, directory, deadline, check=lambda: None,
                 frozen_panel=None):
        self.snapshot = snapshot
        self.request = verify_weight_space_request(request)
        self.session_id, self.runtime_hash = session_id, runtime_hash
        self.request_hash = canonical_sha256(request)
        self.frozen_panel = validate('WeightSpaceFrozenPanelSchema', frozen_panel) if frozen_panel is not None else None
        require((self.frozen_panel is None) == (self.request['frozenEvaluation'] is None), 'weight_space_frozen_panel')
        if self.frozen_panel is not None:
            require(self.frozen_panel['source'] == self.request['frozenEvaluation']
                    and len({p['id'] for p in self.frozen_panel['prompts']}) == len(self.frozen_panel['prompts'])
                    and len(canonical_json(self.frozen_panel).encode()) <= 524_288,
                    'weight_space_frozen_panel')
        self.frozen_panel_hash = canonical_sha256(self.frozen_panel)
        self.directory = Path(directory)
        require(not self.directory.is_symlink(), 'weight_space_session_path')
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.deadline, self.external_check = deadline, check
        snapshot.verify(check)
        self.workspace = TensorWorkspace([layer.mlp.down_proj.weight for layer in snapshot.model.model.layers],
                                         request['model'], request['limits'], self.check, parameters=snapshot.model.named_parameters(), reserve=self.reserve)
        self.state_path = self.directory / 'session.json'
        if self.state_path.exists():
            self.state = read_json(self.state_path, 1_048_576)
            require(self.state['sessionId'] == session_id and self.state['requestHash'] == self.request_hash
                    and self.state['runtimeHash'] == runtime_hash and self.state['deadline'] == deadline,
                    'weight_space_session_identity')
            require(self.state.get('frozenPanelHash') == self.frozen_panel_hash, 'weight_space_frozen_panel')
            self.workspace.arithmetic_work = self.state['usage']['arithmeticWork']
            self._restore_candidates()
            self._recover_pending()
        else:
            now = time.time()
            require(now < deadline <= now + request['limits']['maximumDurationSeconds'] + 1, 'weight_space_deadline')
            self.state = {'sessionId': session_id, 'requestHash': self.request_hash, 'runtimeHash': runtime_hash,
                          'deadline': deadline, 'startedAt': now, 'lastActivityAt': now,
                          'frozenPanelHash': self.frozen_panel_hash,
                          'revision': 1, 'candidateHash': self.workspace.base_hash,
                          'historyHash': canonical_sha256([]), 'candidates': {}, 'pending': None, 'closed': False,
                          'finalization': None,
                          'usage': {'commands': 0, 'candidates': 0, 'arithmeticWork': 0, 'forwardTokenWork': 0}}
            self.persist()
        self.workspace.arithmetic_work = self.state['usage']['arithmeticWork']

    def reserve(self, work):
        self.state['usage']['arithmeticWork'] = work
        self.persist()

    def persist(self):
        atomic_json(self.state_path, self.state)

    def check(self):
        self.external_check()
        require(time.time() < self.deadline, 'weight_space_deadline')
        if hasattr(self, 'state') and self.state['pending'] is None:
            require(time.time() - self.state['lastActivityAt'] < self.request['limits']['maximumIdleSeconds'], 'weight_space_idle_deadline')

    def _receipt_path(self, operation_id):
        return self.directory / ('command-' + hashlib.sha256(operation_id.encode()).hexdigest() + '.json')

    def _restore_candidates(self):
        from safetensors.torch import load_file
        for digest, rows in self.state['candidates'].items():
            require(len(digest) == 64 and all(c in '0123456789abcdef' for c in digest), 'weight_space_candidate_path')
            path = self.directory / f'{digest}.safetensors'
            require(path.is_file() and not path.is_symlink()
                    and path.stat().st_size <= self.request['limits']['maximumCheckpointBytes'], 'weight_space_candidate_file')
            tensors = load_file(str(path))
            candidate = {}
            for row in rows:
                self.workspace.coordinates(row['layer'], row['columns'])
                values = tensors[f"layer{row['layer']}.replacement"]
                require(tuple(values.shape) == (4096, len(row['columns'])), 'weight_space_candidate_geometry')
                for index, column in enumerate(row['columns']):
                    candidate[row['layer'], column] = values[:, index].clone()
            require(self.workspace.candidate_hash(candidate) == digest, 'weight_space_candidate_integrity')
            self.workspace.candidates[digest] = candidate

    def _recover_pending(self):
        pending = self.state['pending']
        if pending is None:
            return
        path = self._receipt_path(pending['operationId'])
        if path.exists():
            retained = read_json(path, 8_388_608)
            verify_weight_space_command_result(retained['result'], pending)
            require(retained['state']['revision'] == self.state['revision'] + 1, 'weight_space_recovery_revision')
            self.state = retained['state']
            self.persist()
            self._restore_candidates()
        else:
            # A forward may already have run; its reserved work remains charged.
            # Never replay an interrupted analysis, mutation or evaluation.
            self._commit(pending, 'rejected', 'weight_space_command_interrupted', self.state['candidateHash'], {}, None)

    def _retain_candidate(self, digest):
        import torch
        from safetensors.torch import save_file
        if digest == self.workspace.base_hash or digest in self.state['candidates']:
            return
        candidate = self.workspace.candidates[digest]
        rows = self.workspace.columns(candidate)
        tensors = {f"layer{row['layer']}.replacement": torch.stack([candidate[row['layer'], c] for c in row['columns']], dim=1)
                   for row in rows}
        temporary = self.directory / f'{digest}.pending'
        require(not temporary.is_symlink(), 'weight_space_candidate_path')
        save_file(tensors, str(temporary))
        require(temporary.stat().st_size <= self.request['limits']['maximumCheckpointBytes'], 'weight_space_checkpoint_budget')
        with temporary.open('rb') as handle:
            os.fsync(handle.fileno())
        temporary.replace(self.directory / f'{digest}.safetensors')
        self.state['candidates'][digest] = rows
        self.state['usage']['candidates'] = len(self.state['candidates'])

    def _commit(self, command, status, code, candidate_hash, tensors, evaluation, catalog=None, final_evaluation=None):
        self.state['usage']['arithmeticWork'] = self.workspace.arithmetic_work
        content = {'schemaVersion': 'openpond.weightSpaceCommandResult.v1', 'sessionId': self.session_id,
                   'operationId': command['operationId'], 'requestHash': canonical_sha256(command),
                   'revision': self.state['revision'] + 1, 'parentCandidateHash': command['candidateHash'],
                   'candidateHash': candidate_hash, 'changedColumns': self.workspace.columns(self.workspace.candidates[candidate_hash]),
                   'status': status, 'code': code, 'tensors': tensors, 'evaluation': evaluation, 'catalog': catalog,
                   'finalEvaluation': final_evaluation,
                   'usage': dict(self.state['usage'])}
        if len(canonical_json(content).encode()) > 900_000:
            # Retain charged work and the original candidate; never emit unbounded output.
            content.update(status='rejected', code='weight_space_output_limit', tensors={}, evaluation=None, catalog=None, finalEvaluation=None,
                           candidateHash=command['candidateHash'], changedColumns=self.workspace.columns(self.workspace.candidates[command['candidateHash']]))
            candidate_hash, status = command['candidateHash'], 'rejected'
        result = {**content, 'contentHash': canonical_sha256(content)}
        verify_weight_space_command_result(result, command)
        state = {**self.state, 'revision': content['revision'], 'candidateHash': candidate_hash, 'pending': None,
                 # Finalization consumes the held-out boundary even on failure.
                 # A failed/partial final forward must never reopen the edit loop.
                 'lastActivityAt': time.time(), 'closed': command['action'] == 'finalize',
                 'finalization': {'operationId': command['operationId'], 'resultHash': result['contentHash'],
                     'historyHashBefore': self.state['historyHash'], 'status': status}
                     if command['action'] == 'finalize' else None,
                 'historyHash': canonical_sha256({'previous': self.state['historyHash'], 'requestHash': content['requestHash'], 'resultHash': result['contentHash']})}
        # A lost ACK or a crash between these writes reconciles the same receipt.
        atomic_json(self._receipt_path(command['operationId']), {'result': result, 'state': state})
        self.state = state
        self.persist()
        return result

    def perform(self, raw):
        command = validate('WeightSpaceCommandSchema', raw)
        require(command['sessionId'] == self.session_id, 'weight_space_command_session')
        receipt = self._receipt_path(command['operationId'])
        if receipt.exists():
            value = read_json(receipt, 8_388_608)['result']
            return verify_weight_space_command_result(value, command)
        self.check()
        require(not self.state['closed'] and self.state['pending'] is None
                and command['expectedRevision'] == self.state['revision']
                and command['candidateHash'] == self.state['candidateHash'], 'weight_space_stale_command')
        require(self.state['usage']['commands'] < self.request['limits']['maximumCommands'], 'weight_space_command_budget')
        self.state['pending'] = command
        self.state['usage']['commands'] += 1
        self.state['lastActivityAt'] = time.time()
        self.persist()
        candidate_hash, tensors, evaluation, code, catalog, final_evaluation = command['candidateHash'], {}, None, None, None, None
        try:
            action = command['action']
            if action == 'catalog':
                catalog = self.workspace.catalog(command['offset'], command['limit'])
            elif action == 'inspect':
                tensors = {'weights': self.workspace.summary(self.workspace.read(self.workspace.candidates[candidate_hash], command['layer'], command['columns']))}
            elif action in ('program', 'code'):
                from .weight_space_code import compile_tensor_code
                program = command['program'] if action == 'program' else compile_tensor_code(command['code'])
                candidate_hash, tensors = self.workspace.program(candidate_hash, program)
                self._retain_candidate(candidate_hash)
            elif action == 'select':
                require(command['targetCandidateHash'] in self.workspace.candidates, 'weight_space_candidate')
                candidate_hash = command['targetCandidateHash']
            elif action == 'evaluate':
                evaluation = self.evaluate(candidate_hash, command['panelId'])
            elif action == 'finalize':
                require(self.workspace.candidates[candidate_hash], 'weight_space_empty_patch')
                if self.frozen_panel is not None:
                    panel = {'id': self.frozen_panel['source']['id'], 'role': 'frozen', **self.frozen_panel}
                    baseline = self.evaluate_panel(self.workspace.base_hash, panel)
                    final_evaluation = self.evaluate_panel(candidate_hash, panel)
                    final_evaluation['baseline'] = {'candidateHash': baseline['candidateHash'], 'rows': baseline['rows']}
                self.export(candidate_hash)
            else:
                raise ValueError('weight_space_action')
        except Exception:
            # Keep typed failure evidence; never leak paths, code, credentials or prompts.
            code, candidate_hash, tensors, evaluation, catalog, final_evaluation = 'weight_space_command_rejected', command['candidateHash'], {}, None, None, None
            # A failed durable candidate write must not leave a selectable memory-only candidate.
            self.workspace.candidates = {key: value for key, value in self.workspace.candidates.items()
                                         if key == self.workspace.base_hash or key in self.state['candidates']}
            if self.workspace.poisoned:
                raise RuntimeError('weight_space_session_unusable') from None
        return self._commit(command, 'rejected' if code else 'succeeded', code, candidate_hash, tensors, evaluation, catalog, final_evaluation)

    def evaluate(self, candidate_hash, panel_id):
        panels = [p for p in self.request['panels'] if p['id'] == panel_id]
        require(len(panels) == 1, 'weight_space_panel')
        return self.evaluate_panel(candidate_hash, panels[0])

    def evaluate_panel(self, candidate_hash, panel):
        import torch
        from .generation import generate_greedy
        rows = []
        def reserve(work):
            require(self.state['usage']['forwardTokenWork'] + work
                    <= self.request['limits']['maximumForwardTokenWork'], 'weight_space_forward_budget')
            self.state['usage']['forwardTokenWork'] += work
            self.persist()

        with self.workspace.installed(candidate_hash), torch.no_grad():
            for prompt in panel['prompts']:
                output = generate_greedy(self.snapshot.model, self.snapshot.tokenizer,
                    ([{'role': 'system', 'content': prompt['system']}] if 'system' in prompt else [])
                    + [{'role': 'user', 'content': prompt['text']}],
                    max_output_tokens=self.request['generation']['maxOutputTokens'], reserve=reserve, check=self.check)
                rows.append({'id': prompt['id'], 'inputHash': canonical_sha256(prompt), **output})
        return {'panelId': panel['id'], 'role': panel['role'], 'candidateHash': candidate_hash,
                'sampling': 'greedy_v1', 'seed': self.request['generation']['seed'], 'rows': rows,
                **({'source': panel['source']} if panel['role'] == 'frozen' else {})}

    def export(self, candidate_hash):
        import torch
        from safetensors.torch import load_file, save_file
        candidate = self.workspace.candidates[candidate_hash]
        require(candidate, 'weight_space_empty_patch')
        self.check()
        self.snapshot.verify(self.check)  # Full pristine base identity after all temporary evaluations.
        rows = self.workspace.columns(candidate)
        tensors, inventory, column_hashes = {}, [], []
        for row in rows:
            name = f"layer{row['layer']}"
            values = torch.stack([candidate[row['layer'], c] for c in row['columns']], dim=1)
            tensors[f'{name}.indices'] = torch.tensor(row['columns'], dtype=torch.int64)
            tensors[f'{name}.replacement'] = values
            inventory.extend([{'name': f'{name}.indices', 'dtype': 'I64', 'shape': [len(row['columns'])]},
                              {'name': f'{name}.replacement', 'dtype': 'BF16', 'shape': [4096, len(row['columns'])]}])
            column_hashes.append(tensor_hash(values))
        module = self.directory / 'module'
        module.mkdir(mode=0o700, exist_ok=True)
        path = module / 'patch.safetensors'
        save_file(tensors, str(path))
        require(path.stat().st_size <= self.request['limits']['maximumCheckpointBytes'], 'weight_space_checkpoint_budget')
        reloaded = load_file(str(path))
        require(all(torch.equal(reloaded[key], value) for key, value in tensors.items()), 'weight_space_reload_mismatch')
        columns_hash = canonical_sha256(column_hashes)
        content = {'schemaVersion': 'openpond.weightSpaceArtifact.v1', 'method': 'weight_space_programming',
                   'representation': 'exact_bf16_mlp_column_replacements_v1', 'model': self.request['model'],
                   'requestHash': self.request_hash, 'runtimeHash': self.runtime_hash, 'candidateHash': candidate_hash,
                   'teacher': self.request['teacher'], 'historyHash': self.state['historyHash'],
                   'columns': rows, 'columnHashes': column_hashes,
                   'payload': {'path': 'patch.safetensors', 'sha256': file_hash(path, self.check), 'sizeBytes': path.stat().st_size,
                               'tensors': sorted(inventory, key=lambda row: row['name'])},
                   'reload': {'effectiveColumnsHash': columns_hash,
                              'reloadedColumnsHash': canonical_sha256([tensor_hash(reloaded[f"layer{row['layer']}.replacement"]) for row in rows]),
                              'untouchedWeightsHashBefore': self.request['model']['weightsHash'],
                              'untouchedWeightsHashAfter': self.request['model']['weightsHash'], 'equivalent': True}}
        manifest = {**content, 'contentHash': canonical_sha256(content)}
        from ..weight_space_programming import verify_weight_space_artifact
        verify_weight_space_artifact(manifest, self.request, self.runtime_hash)
        atomic_json(module / 'manifest.json', manifest)
        files = [{'path': file.name, 'sha256': file_hash(file, self.check), 'sizeBytes': file.stat().st_size}
                 for file in (module / 'manifest.json', path)]
        atomic_json(self.directory / 'export.json', {'manifest': manifest, 'files': files,
                    'commands': self.state['usage']['commands'], 'candidates': self.state['usage']['candidates'],
                    'forwardTokenWork': self.state['usage']['forwardTokenWork'],
                    'durationMs': max(0, (time.time() - self.state['startedAt']) * 1000)})
        return manifest
