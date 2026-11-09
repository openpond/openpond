"""Bounded tensor programs over immutable base columns; no executable Python input."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import math

from ..wire import canonical_sha256
from .artifacts import require


def tensor_hash(value):
    import torch
    return hashlib.sha256(value.detach().contiguous().cpu().view(torch.uint8).numpy().tobytes()).hexdigest()


class TensorWorkspace:
    """The model stays pristine between evaluations. Candidates own BF16 replacements."""

    def __init__(self, projections, model_identity, limits, check=lambda: None, *, parameters=None, reserve=lambda work: None):
        import torch
        self.projections = projections
        self.parameters = dict(parameters or {})
        self.reserve = reserve
        self.model_identity = model_identity
        self.limits, self.check = limits, check
        require(projections and all(p.dtype == torch.bfloat16 and p.ndim == 2
                                   and not p.requires_grad for p in projections), 'weight_space_frozen_projections')
        self.hidden = projections[0].shape[0]
        require(all(p.shape[0] == self.hidden for p in projections), 'weight_space_projection_geometry')
        self.base_hash = self.candidate_hash({})
        self.candidates = {self.base_hash: {}}
        self.arithmetic_work = 0
        self.poisoned = False

    def consume(self, cost):
        require(type(cost) is int and cost >= 0 and self.arithmetic_work + cost <= self.limits['maximumArithmeticWork'], 'weight_space_arithmetic_budget')
        self.arithmetic_work += cost
        self.reserve(self.arithmetic_work)

    def candidate_hash(self, replacements):
        rows = []
        for layer in sorted({layer for layer, _ in replacements}):
            columns = sorted(column for current, column in replacements if current == layer)
            import torch
            values = torch.stack([replacements[layer, column] for column in columns], dim=1)
            rows.append({'layer': layer, 'columns': columns, 'sha256': tensor_hash(values)})
        return canonical_sha256({'schemaVersion': 'openpond.weightSpaceCandidate.v1',
                                 'model': self.model_identity, 'columns': rows})

    def coordinates(self, layer, columns):
        require(type(layer) is int and 0 <= layer < len(self.projections)
                and type(columns) is list and 0 < len(columns) <= self.limits['maximumPatchColumns']
                and all(type(c) is int and 0 <= c < self.projections[layer].shape[1] for c in columns)
                and columns == sorted(set(columns)), 'weight_space_coordinates')

    def read(self, replacements, layer, columns, source='candidate'):
        import torch
        self.coordinates(layer, columns)
        require(source in ('base', 'candidate'), 'weight_space_read_source')
        require(self.hidden * len(columns) <= self.limits['maximumTensorElements'], 'weight_space_tensor_budget')
        self.consume(self.hidden * len(columns))
        return torch.stack([replacements.get((layer, c), self.projections[layer][:, c]).detach().cpu()
                            if source == 'candidate' else self.projections[layer][:, c].detach().cpu()
                            for c in columns], dim=1).float()

    def read_tensor(self, candidate, name, ranges, source):
        import torch
        require(name in self.parameters and source in ('base', 'candidate'), 'weight_space_tensor_name')
        tensor = self.parameters[name]
        require(len(ranges) == tensor.ndim and tensor.ndim in (1, 2), 'weight_space_tensor_rank')
        slices = []
        for size, row in zip(tensor.shape, ranges):
            require(type(row['start']) is int and type(row['stop']) is int and 0 <= row['start'] < row['stop'] <= size,
                    'weight_space_tensor_range')
            slices.append(slice(row['start'], row['stop']))
        count = math.prod(row['stop']-row['start'] for row in ranges)
        require(count <= self.limits['maximumTensorElements'], 'weight_space_tensor_budget')
        self.consume(count)
        value = tensor[tuple(slices)].detach().cpu().float().clone()
        if source == 'candidate':
            for layer, projection in enumerate(self.projections):
                if tensor is projection:
                    for column in range(ranges[1]['start'], ranges[1]['stop']):
                        if (layer, column) in candidate:
                            value[:, column-ranges[1]['start']] = candidate[layer, column][slices[0]].float()
        return value

    def catalog(self, offset, limit):
        names = sorted(self.parameters)
        require(type(offset) is int and 0 <= offset <= len(names) and type(limit) is int and 0 < limit <= 128, 'weight_space_catalog')
        return {'items': [{'name': name, 'shape': list(self.parameters[name].shape), 'dtype': 'BF16',
                           'editable': any(self.parameters[name] is p for p in self.projections)} for name in names[offset:offset+limit]],
                'nextOffset': offset+limit if offset+limit < len(names) else None}

    def summary(self, value):
        import torch
        self.consume(value.numel() * 5)
        value = value.detach().float().cpu().contiguous()
        require(value.numel() > 0 and bool(torch.isfinite(value).all()), 'weight_space_nonfinite')
        maximum = self.limits['maximumReturnedValues']
        flat = value.reshape(-1)
        return {'shape': list(value.shape), 'minimum': float(value.min()), 'maximum': float(value.max()),
                'mean': float(value.mean()), 'norm': float(torch.linalg.vector_norm(value)),
                'values': flat[:maximum].tolist(), 'truncated': value.numel() > maximum}

    def columns(self, replacements):
        return [{'layer': layer, 'columns': sorted(c for current, c in replacements if current == layer)}
                for layer in sorted({layer for layer, _ in replacements})]

    def program(self, candidate_hash, program):
        import torch
        require(not self.poisoned and candidate_hash in self.candidates, 'weight_space_candidate')
        candidate = dict(self.candidates[candidate_hash])
        variables, writes = {}, False
        allowed = {
            'read_tensor': {'op', 'out', 'name', 'source', 'ranges'},
            'read': {'op', 'out', 'source', 'layer', 'columns'},
            'literal': {'op', 'out', 'shape', 'values'}, 'scale': {'op', 'out', 'input', 'factor'},
            'add': {'op', 'out', 'left', 'right'}, 'subtract': {'op', 'out', 'left', 'right'},
            'matmul': {'op', 'out', 'left', 'right'},
            **{op: {'op', 'out', 'input'} for op in ('transpose', 'normalize_columns', 'mean_columns', 'singular_vectors')},
            'slice': {'op', 'out', 'input', 'axis', 'start', 'stop'}, 'write': {'op', 'input', 'layer', 'columns'},
        }
        require(type(program) is dict and set(program) == {'instructions', 'returns'}
                and type(program['instructions']) is list and 0 < len(program['instructions']) <= 64
                and type(program['returns']) is list and len(program['returns']) <= 8, 'weight_space_program')
        with torch.no_grad():
            for step in program['instructions']:
                self.check()
                require(type(step) is dict and step.get('op') in allowed and set(step) == allowed[step['op']], 'weight_space_instruction')
                op = step['op']
                if op == 'write':
                    self.coordinates(step['layer'], step['columns'])
                    value = variables[step['input']]
                    require(tuple(value.shape) == (self.hidden, len(step['columns'])), 'weight_space_write_geometry')
                    self.consume(value.numel() * 2)
                    rounded = value.to(torch.bfloat16)
                    require(bool(torch.isfinite(rounded).all()), 'weight_space_write_nonfinite')
                    for offset, column in enumerate(step['columns']):
                        key = (step['layer'], column)
                        replacement = rounded[:, offset].contiguous().clone()
                        if torch.equal(replacement, self.projections[key[0]][:, key[1]].detach().cpu()):
                            candidate.pop(key, None)
                        else:
                            candidate[key] = replacement
                    require(len(candidate) <= self.limits['maximumPatchColumns'], 'weight_space_patch_budget')
                    writes = True
                    continue
                out = step['out']
                require(type(out) is str and out not in variables and 0 < len(out) <= 40, 'weight_space_variable')
                operands = [variables[step[k]] for k in ('input', 'left', 'right') if k in step]
                cost = sum(v.numel() for v in operands)
                if op == 'read':
                    self.coordinates(step['layer'], step['columns'])
                    cost = self.hidden * len(step['columns'])
                elif op == 'read_tensor':
                    cost = math.prod(row['stop']-row['start'] for row in step['ranges'])
                    require(0 < cost <= self.limits['maximumTensorElements'], 'weight_space_tensor_budget')
                elif op == 'literal':
                    cost = len(step['values'])
                if op in ('add', 'subtract'):
                    shape = torch.broadcast_shapes(operands[0].shape, operands[1].shape)
                    require(len(shape) <= 2 and math.prod(shape) <= self.limits['maximumTensorElements'], 'weight_space_broadcast_budget')
                    cost = math.prod(shape)
                if op == 'matmul':
                    a, b = operands
                    require(a.ndim == b.ndim == 2 and a.shape[1] == b.shape[0]
                            and a.shape[0] * b.shape[1] <= self.limits['maximumTensorElements'], 'weight_space_matmul_geometry')
                    cost = a.shape[0] * a.shape[1] * b.shape[1]
                if op == 'singular_vectors':
                    require(operands[0].ndim == 2, 'weight_space_svd_geometry')
                    cost = operands[0].numel() * min(operands[0].shape) ** 2
                # Consume work before dispatch, including a numerically failing operation.
                if op not in ('read', 'read_tensor'): self.consume(cost)
                if op == 'read_tensor':
                    value = self.read_tensor(candidate, step['name'], step['ranges'], step['source'])
                elif op == 'read':
                    value = self.read(candidate, step['layer'], step['columns'], step['source'])
                elif op == 'literal':
                    require(type(step['shape']) is list and 1 <= len(step['shape']) <= 2
                            and all(type(v) is int and 0 < v <= 4096 for v in step['shape'])
                            and math.prod(step['shape']) == len(step['values']) <= 4096
                            and all(type(v) in (int, float) and math.isfinite(v) for v in step['values']), 'weight_space_literal')
                    value = torch.tensor(step['values'], dtype=torch.float32).reshape(step['shape'])
                elif op == 'scale':
                    require(type(step['factor']) in (float, int) and math.isfinite(step['factor']), 'weight_space_factor')
                    value = operands[0] * step['factor']
                elif op in ('add', 'subtract'):
                    a, b = operands
                    shape = torch.broadcast_shapes(a.shape, b.shape)
                    require(len(shape) <= 2 and math.prod(shape) <= self.limits['maximumTensorElements'], 'weight_space_broadcast_budget')
                    value = a + b if op == 'add' else a - b
                elif op == 'matmul':
                    value = operands[0] @ operands[1]
                elif op == 'transpose':
                    require(operands[0].ndim == 2, 'weight_space_transpose_geometry')
                    value = operands[0].T.contiguous()
                elif op == 'normalize_columns':
                    value = operands[0] / torch.linalg.vector_norm(operands[0], dim=0, keepdim=True).clamp_min(1e-12)
                elif op == 'mean_columns':
                    require(operands[0].ndim == 2, 'weight_space_mean_geometry')
                    value = operands[0].mean(dim=1, keepdim=True)
                elif op == 'singular_vectors':
                    value = torch.linalg.svd(operands[0], full_matrices=False).U
                elif op == 'slice':
                    source = operands[0]
                    axis, start, stop = step['axis'], step['start'], step['stop']
                    require(type(axis) is int and 0 <= axis < source.ndim and type(start) is int and type(stop) is int
                            and 0 <= start < stop <= source.shape[axis], 'weight_space_slice')
                    value = source.narrow(axis, start, stop - start).contiguous()
                else:
                    raise ValueError('weight_space_instruction')
                require(value.numel() and value.numel() <= self.limits['maximumTensorElements']
                        and value.ndim <= 2 and bool(torch.isfinite(value).all()), 'weight_space_tensor_result')
                variables[out] = value
                require(sum(v.numel() for v in variables.values()) <= self.limits['maximumTensorElements'], 'weight_space_workspace_budget')
        names = program['returns']
        require(len(names) == len(set(names)) and all(n in variables for n in names), 'weight_space_returns')
        require(sum(min(variables[n].numel(), self.limits['maximumReturnedValues']) for n in names)
                <= self.limits['maximumReturnedValues'], 'weight_space_return_budget')
        result = {name: self.summary(variables[name]) for name in names}
        updated_hash = self.candidate_hash(candidate)
        if writes and updated_hash not in self.candidates:
            require(len(self.candidates) - 1 < self.limits['maximumCandidates'], 'weight_space_candidate_budget')
            self.candidates[updated_hash] = candidate
        return updated_hash, result

    @contextmanager
    def installed(self, candidate_hash):
        import torch
        require(not self.poisoned and candidate_hash in self.candidates, 'weight_space_candidate')
        replacements = self.candidates[candidate_hash]
        staged = [(self.projections[layer], column, value.to(self.projections[layer].device))
                  for (layer, column), value in replacements.items()]
        originals = [(target, column, target[:, column].detach().clone()) for target, column, _ in staged]
        try:
            with torch.no_grad():
                for target, column, replacement in staged:
                    target[:, column].copy_(replacement)
                for device in {target.device for target, _, _ in staged if target.device.type == 'cuda'}:
                    torch.cuda.synchronize(device)
            yield
        finally:
            try:
                with torch.no_grad():
                    for target, column, original in originals:
                        target[:, column].copy_(original)
                    for device in {target.device for target, _, _ in originals if target.device.type == 'cuda'}:
                        torch.cuda.synchronize(device)
            except BaseException:
                self.poisoned = True
                raise RuntimeError('weight_space_rollback_failed') from None
