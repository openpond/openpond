"""Compile bounded tensor-analysis Python syntax; never execute Python source.

The language exposes tensor reads, matrix arithmetic, decomposition, column
writes and bounded summaries. It has no imports, loops, model forwards, files,
network, autograd, user-defined calls or access to Python objects.
"""
from __future__ import annotations
import ast
import math
import re
from .artifacts import require


def compile_tensor_code(source):
    require(type(source) is str and 0 < len(source.encode()) <= 32_768, 'weight_space_code_size')
    tree = ast.parse(source, mode='exec')
    require(sum(1 for _ in ast.walk(tree)) <= 1024, 'weight_space_code_complexity')
    instructions, symbols, returns = [], {}, []

    def append(op, *, out=None, **fields):
        require(len(instructions) < 64, 'weight_space_code_instruction_limit')
        if out is None and op != 'write':
            out = f'tmp_{len(instructions)}'
        instructions.append({'op': op, **({'out': out} if out else {}), **fields})
        return out

    def static(node):
        # literal_eval cannot invoke a function, inspect an object or load a name.
        value = ast.literal_eval(node)
        require(not isinstance(value, (bytes, set, dict)), 'weight_space_code_literal')
        return value

    def scalar(node):
        value = static(node)
        require(type(value) in (int, float) and math.isfinite(value), 'weight_space_code_scalar')
        return value

    def call(node, name, positional, optional=()):
        require(isinstance(node.func, ast.Name) and node.func.id == name and len(node.args) == len(positional)
                and all(k.arg in optional for k in node.keywords)
                and len({k.arg for k in node.keywords}) == len(node.keywords), 'weight_space_code_call')
        return {**dict(zip(positional, node.args)), **{k.arg: k.value for k in node.keywords}}

    def expression(node, out=None, depth=0):
        require(depth <= 24, 'weight_space_code_depth')
        if isinstance(node, ast.Name):
            require(node.id in symbols, 'weight_space_code_name')
            if out is None:
                return symbols[node.id]
            return append('scale', out=out, input=symbols[node.id], factor=1.)
        if isinstance(node, ast.BinOp):
            left = expression(node.left, depth=depth+1)
            if isinstance(node.op, (ast.Mult, ast.Div)):
                factor = scalar(node.right)
                require(not isinstance(node.op, ast.Div) or factor != 0, 'weight_space_code_division')
                return append('scale', out=out, input=left, factor=1/factor if isinstance(node.op, ast.Div) else factor)
            require(isinstance(node.op, (ast.Add, ast.Sub, ast.MatMult)), 'weight_space_code_operator')
            right = expression(node.right, depth=depth+1)
            return append('add' if isinstance(node.op, ast.Add) else 'subtract' if isinstance(node.op, ast.Sub) else 'matmul', out=out, left=left, right=right)
        if isinstance(node, ast.Attribute):
            require(node.attr == 'T', 'weight_space_code_attribute')
            return append('transpose', out=out, input=expression(node.value, depth=depth+1))
        require(isinstance(node, ast.Call) and isinstance(node.func, ast.Name), 'weight_space_code_expression')
        name = node.func.id
        if name == 'read':
            args = call(node, name, ('layer', 'columns'), ('source',))
            return append('read', out=out, layer=static(args['layer']), columns=static(args['columns']),
                          source=static(args['source']) if 'source' in args else 'candidate')
        if name == 'read_tensor':
            args = call(node, name, ('name', 'ranges'), ('source',))
            ranges = static(args['ranges'])
            require(type(ranges) is list and 1 <= len(ranges) <= 2 and all(type(r) in (tuple, list) and len(r) == 2 for r in ranges), 'weight_space_code_ranges')
            return append('read_tensor', out=out, name=static(args['name']), ranges=[{'start': r[0], 'stop': r[1]} for r in ranges],
                          source=static(args['source']) if 'source' in args else 'candidate')
        if name == 'literal':
            args = call(node, name, ('shape', 'values'))
            return append('literal', out=out, shape=static(args['shape']), values=static(args['values']))
        require(name in ('normalize_columns', 'mean_columns', 'singular_vectors', 'transpose'), 'weight_space_code_function')
        args = call(node, name, ('input',))
        return append(name, out=out, input=expression(args['input'], depth=depth+1))

    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            require(len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name), 'weight_space_code_assignment')
            name = statement.targets[0].id
            require(re.fullmatch(r'[a-z][a-z0-9_]{0,39}', name) and not name.startswith('tmp_') and name not in symbols,
                    'weight_space_code_variable')
            symbols[name] = expression(statement.value, out=name)
            continue
        require(isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
                and isinstance(statement.value.func, ast.Name), 'weight_space_code_statement')
        node = statement.value
        if node.func.id == 'write':
            args = call(node, 'write', ('input', 'layer', 'columns'))
            append('write', input=expression(args['input']), layer=static(args['layer']), columns=static(args['columns']))
        else:
            require(node.func.id == 'show' and not node.keywords and 1 <= len(node.args) <= 8, 'weight_space_code_show')
            for argument in node.args:
                name = expression(argument)
                require(name not in returns and len(returns) < 8, 'weight_space_code_returns')
                returns.append(name)
    from ..wire import validate
    # Shape, coordinates and finite literals pass the same canonical program boundary.
    return validate('WeightSpaceProgramSchema', {'instructions': instructions, 'returns': returns})
