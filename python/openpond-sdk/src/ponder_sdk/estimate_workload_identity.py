"""Native workload refinements and exact submission bindings."""
from math import ceil
from typing import Any
from .errors import ProtocolError
from .wire import canonical_sha256


def _require(condition: bool) -> None:
    if not condition:
        raise ProtocolError('training_estimate_scope_mismatch')


def _tokens(tokens: dict[str, Any], count: int) -> None:
    _require(tokens['retainedPromptTokens'] <= tokens['promptTokens']
             and tokens['inputTokens'] == tokens['retainedPromptTokens'] + tokens['targetTokens']
             and (tokens['truncatedPrompts'] == 0) == (tokens['promptTokens'] == tokens['retainedPromptTokens'])
             and tokens['truncatedPrompts'] <= count
             and tokens['retainedPromptTokens'] >= count and tokens['targetTokens'] >= count)


def verify_workload(estimate: dict[str, Any], request: dict[str, Any]) -> None:
    workload = estimate.get('workload')
    if workload is None:
        return
    method, identity, preprocessing = workload['method'], workload['identity'], workload['preprocessing']
    config = estimate['configuration']
    sft = method == 'sft'
    rows = workload['trainingRows']['total'] if sft else workload['trainingRows']
    _require(method == config['method'])
    if identity:
        _require(identity['baseModel']['modelId'] == config['modelId']
                 and identity['baseModel']['revision'] == config['modelRevision'])
    for actual, expected in [(rows, config['trainingRows']), (workload['evaluationRows'], config['evaluationRows'])]:
        _require(actual is None or expected is None or actual == expected)
    populations = [workload['trainingRows'] if sft else workload['trainingInitialRequests'], workload['evaluationInitialRequests']]
    for population in populations:
        total, counted, tokens = population['total'], population['counted'], population['totals']
        _require(total is None or counted <= total)
        if population['coverage'] == 'unavailable':
            _require(counted == 0 and tokens is None and population['inputsHash'] is None and bool(population['reason']))
        else:
            _require(tokens is not None and population['inputsHash'] is not None)
            _require(population['coverage'] != 'complete' or total is not None and counted == total)
            _require(population['coverage'] != 'bounded' or bool(population['reason']))
            if population is workload['trainingRows'] and sft:
                _tokens(tokens, counted)
            else:
                _require(tokens['promptTokens'] >= counted)
    if not identity or not preprocessing:
        _require(bool(workload['unavailableReason'])
                 and all(p['coverage'] == 'unavailable' for p in populations)
                 and (not sft or workload['planned']['tokenTotals'] is None))
    if sft:
        planned = workload['planned']
        exposures, steps, tokens = planned['exampleExposures'], planned['optimizerSteps'], planned['tokenTotals']
        _require((exposures is None) == (steps is None) == (planned['exposuresHash'] is None))
        if exposures is not None:
            _require(identity is not None and rows is not None and steps <= exposures and (exposures == 0) == (steps == 0))
        if tokens:
            _require(exposures is not None)
            _tokens(tokens, exposures)
        if not identity or exposures is None or tokens is None:
            _require(bool(planned['reason']))
        if preprocessing:
            limit = preprocessing['maxSequenceLength']
            row_tokens = workload['trainingRows']['totals']
            _require(row_tokens is None or row_tokens['inputTokens'] <= limit * workload['trainingRows']['counted'])
            _require(tokens is None or tokens['inputTokens'] <= limit * exposures)
    elif preprocessing:
        population = workload['trainingInitialRequests']
        _require(population['totals'] is None or population['totals']['promptTokens'] <= preprocessing['maxPromptTokens'] * population['counted'])
    if request['source']['kind'] != 'submission':
        return
    submission = request['source']['submission']
    job, source = submission['job'], submission['source']
    _require(job['kind'] == 'policy_optimize' and method == job['recipe']['method'])
    if identity:
        _require(identity['recipeHash'] == canonical_sha256(job['recipe'])
                 and canonical_sha256(identity['baseModel']) == canonical_sha256(job['baseModel']))
        expected = {key: source[key] for key in ['harnessRunManifest', 'harnessRelease', 'dataset', 'evidenceSets']}
        expected['evaluationDataset'] = source.get('evaluation', {}).get('dataset') if source.get('evaluation') else None
        _require(canonical_sha256({key: identity[key] for key in expected}) == canonical_sha256(expected))
    recipe = job['recipe']
    if sft and (preprocessing or workload['planned']['exampleExposures'] is not None):
        _require(recipe['method'] == 'sft')
        if preprocessing:
            _require(preprocessing['maxSequenceLength'] == recipe['dataset']['maxSequenceLength'])
        if workload['planned']['exampleExposures'] is not None and rows is not None:
            optimizer = recipe['optimizer']
            window = optimizer['batchSize'] * optimizer['gradientAccumulationSteps']
            exposures = min(ceil(rows * optimizer['epochs']), optimizer['maxSteps'] * window)
            _require(workload['planned']['exampleExposures'] == exposures
                     and workload['planned']['optimizerSteps'] == ceil(exposures / window))
    elif not sft and preprocessing:
        _require(preprocessing['maxPromptTokens'] == recipe['dataset']['maxPromptTokens'])
