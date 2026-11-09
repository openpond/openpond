"""Configured task submission; source identity is distinct from canonical task IDs."""
from __future__ import annotations
from typing import cast
from uuid import uuid4
from . import inputs, models
from .errors import ProtocolError, PonderError
from .datasets import Datasets, AsyncDatasets

class TaskInput(inputs.DatasetTaskInput, total=False):
    id: str

def submission(task: TaskInput, idempotency_key: str | None = None) -> inputs.DatasetTaskAppendRequest:
    content = dict(task)
    source_id = content.pop('id', None)
    if source_id is not None and idempotency_key is not None and source_id != idempotency_key:
        raise ProtocolError('conflicting_source_identity')
    return cast(inputs.DatasetTaskAppendRequest, {'schemaVersion': 'openpond.datasetTaskAppend.v1', 'operationId': source_id if source_id is not None else idempotency_key if idempotency_key is not None else str(uuid4()), 'task': content})

class DatasetBinding:
    def __init__(self, datasets: Datasets, dataset_id: str):
        self._datasets = datasets
        self.dataset_id = dataset_id
    def add_task(self, task: TaskInput, *, idempotency_key: str | None = None) -> models.DatasetTaskAppendReceipt:
        body = submission(task, idempotency_key)
        try:
            return self._datasets.add_task(self.dataset_id, body)
        except PonderError as error:
            error.operation_id = body['operationId']
            raise

class AsyncDatasetBinding:
    def __init__(self, datasets: AsyncDatasets, dataset_id: str):
        self._datasets = datasets
        self.dataset_id = dataset_id
    async def add_task(self, task: TaskInput, *, idempotency_key: str | None = None) -> models.DatasetTaskAppendReceipt:
        body = submission(task, idempotency_key)
        try:
            return await self._datasets.add_task(self.dataset_id, body)
        except PonderError as error:
            error.operation_id = body['operationId']
            raise
