"""Native clients share one explicitly owned HTTP connection pool."""
from __future__ import annotations
from .transport import Transport,AsyncTransport
from .errors import PonderError
from .training import Training,AsyncTraining
from .models_client import Models,AsyncModels
from .learning import Learning,AsyncLearning
from .post_training import PostTraining,AsyncPostTraining
from .evaluation_runs import EvaluationRuns,AsyncEvaluationRuns
from .datasets import Datasets,AsyncDatasets
from .tool_learning import ToolLearning,AsyncToolLearning
from .dataset_preparations import DatasetPreparations,AsyncDatasetPreparations

class Client:
    def __init__(self,*,base_url:str,api_key:str,team_id:str,timeout:float=30,read_attempts:int=3):
        self.team_id=team_id
        self._transport=Transport(base_url,api_key,team_id,timeout=timeout,read_attempts=read_attempts)
        self.training=Training(self._transport,team_id)
        self.models=Models(self._transport,team_id)
        self.learning=Learning(self._transport,team_id)
        self.post_training=PostTraining(self._transport,team_id)
        self.evaluation_runs=EvaluationRuns(self._transport,team_id)
        self.datasets=Datasets(self._transport,team_id)
        self.dataset_preparations=DatasetPreparations(self._transport,team_id)
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
    def __init__(self,*,base_url:str,api_key:str,team_id:str,timeout:float=30,read_attempts:int=3):
        self.team_id=team_id
        self._transport=AsyncTransport(base_url,api_key,team_id,timeout=timeout,read_attempts=read_attempts)
        self.training=AsyncTraining(self._transport,team_id)
        self.models=AsyncModels(self._transport,team_id)
        self.learning=AsyncLearning(self._transport,team_id)
        self.post_training=AsyncPostTraining(self._transport,team_id)
        self.evaluation_runs=AsyncEvaluationRuns(self._transport,team_id)
        self.datasets=AsyncDatasets(self._transport,team_id)
        self.dataset_preparations=AsyncDatasetPreparations(self._transport,team_id)
    def tool_learning(self, *, project_id: str) -> AsyncToolLearning:
        """Bind tool learning to one project using this client's async pool."""
        return AsyncToolLearning(self._transport, self.team_id, project_id)
    async def close(self)->None:await self._transport.close()
    async def __aenter__(self)->AsyncClient:return self
    async def __aexit__(self,*exception)->None:
        try:await self.close()
        except PonderError:
            if exception[0] is None:raise
