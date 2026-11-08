"""Native clients share one explicitly owned HTTP connection pool."""
from __future__ import annotations
from .transport import Transport,AsyncTransport
from .errors import PonderError, ProtocolError
from . import models
from .task_submission import TaskInput, DatasetBinding, AsyncDatasetBinding
from .product_models import ModelBinding
from .training import Training,AsyncTraining
from .models_client import Models,AsyncModels
from .learning import Learning,AsyncLearning
from .post_training import PostTraining,AsyncPostTraining
from .evaluation_runs import EvaluationRuns,AsyncEvaluationRuns
from .datasets import Datasets,AsyncDatasets
from .tool_learning import ToolLearning,AsyncToolLearning
from .dataset_preparations import DatasetPreparations,AsyncDatasetPreparations

class Client:
    def __init__(self,*,base_url:str,api_key:str,team_id:str,timeout:float=30,read_attempts:int=3,dataset_id:str|None=None,serving_base_url:str|None=None,serving_api_key:str|None=None,model_aliases:dict[str,str|ModelBinding]|None=None):
        self.team_id=team_id
        self.dataset_id=dataset_id
        self._transport=Transport(base_url,api_key,team_id,timeout=timeout,read_attempts=read_attempts)
        self.training=Training(self._transport,team_id)
        self.models=Models(self._transport,team_id)
        self.models.configure_aliases(model_aliases or {}, serving_base_url, serving_api_key or api_key)
        self.learning=Learning(self._transport,team_id)
        self.post_training=PostTraining(self._transport,team_id)
        self.evaluation_runs=EvaluationRuns(self._transport,team_id)
        self.datasets=Datasets(self._transport,team_id)
        self.dataset_preparations=DatasetPreparations(self._transport,team_id)
    def dataset(self, dataset_id: str) -> DatasetBinding:
        return DatasetBinding(self.datasets, dataset_id)
    def add_task(self, task_or_dataset: TaskInput | str, task: TaskInput | None = None, *, idempotency_key: str | None = None) -> models.DatasetTaskAppendReceipt:
        """Awaiting is unnecessary in sync code: this blocks until durable receipt."""
        destination = task_or_dataset if isinstance(task_or_dataset,str) else self.dataset_id
        content = task if isinstance(task_or_dataset,str) else task_or_dataset
        if not destination or content is None:
            raise ProtocolError('dataset_binding_required')
        return self.dataset(destination).add_task(content,idempotency_key=idempotency_key)
    def tool_learning(self, *, project_id: str) -> ToolLearning:
        """Bind tool learning to one project without creating another HTTP pool."""
        return ToolLearning(self._transport, self.team_id, project_id)
    def close(self)->None:self._transport.close()
    def __enter__(self)->Client:return self
    def __exit__(self,*exception)->None:
        try:self.close()
        except PonderError:
            if exception[0] is None:raise

class AsyncClient:
    def __init__(self,*,base_url:str,api_key:str,team_id:str,timeout:float=30,read_attempts:int=3,dataset_id:str|None=None,serving_base_url:str|None=None,serving_api_key:str|None=None,model_aliases:dict[str,str|ModelBinding]|None=None):
        self.team_id=team_id
        self.dataset_id=dataset_id
        self._transport=AsyncTransport(base_url,api_key,team_id,timeout=timeout,read_attempts=read_attempts)
        self.training=AsyncTraining(self._transport,team_id)
        self.models=AsyncModels(self._transport,team_id)
        self.models.configure_aliases(model_aliases or {}, serving_base_url, serving_api_key or api_key)
        self.learning=AsyncLearning(self._transport,team_id)
        self.post_training=AsyncPostTraining(self._transport,team_id)
        self.evaluation_runs=AsyncEvaluationRuns(self._transport,team_id)
        self.datasets=AsyncDatasets(self._transport,team_id)
        self.dataset_preparations=AsyncDatasetPreparations(self._transport,team_id)
    def dataset(self, dataset_id: str) -> AsyncDatasetBinding:
        return AsyncDatasetBinding(self.datasets, dataset_id)
    async def add_task(self, task_or_dataset: TaskInput | str, task: TaskInput | None = None, *, idempotency_key: str | None = None) -> models.DatasetTaskAppendReceipt:
        """Await the durable receipt using the existing async HTTP pool."""
        destination = task_or_dataset if isinstance(task_or_dataset,str) else self.dataset_id
        content = task if isinstance(task_or_dataset,str) else task_or_dataset
        if not destination or content is None:
            raise ProtocolError('dataset_binding_required')
        return await self.dataset(destination).add_task(content,idempotency_key=idempotency_key)
    def tool_learning(self, *, project_id: str) -> AsyncToolLearning:
        """Bind tool learning to one project using this client's async pool."""
        return AsyncToolLearning(self._transport, self.team_id, project_id)
    async def close(self)->None:await self._transport.close()
    async def __aenter__(self)->AsyncClient:return self
    async def __aexit__(self,*exception)->None:
        try:await self.close()
        except PonderError:
            if exception[0] is None:raise
