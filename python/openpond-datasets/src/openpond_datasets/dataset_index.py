from __future__ import annotations

from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory


class DatasetIndex:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection
        connection.executescript(
            """
            CREATE TABLE row_fingerprints(
                task_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE cluster_splits(
                cluster_key TEXT PRIMARY KEY,
                split TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE curriculum_prompts(
                prompt TEXT PRIMARY KEY
            ) WITHOUT ROWID;
            CREATE TABLE selection(
                priority BLOB NOT NULL,
                task_id TEXT NOT NULL,
                encoded TEXT NOT NULL,
                PRIMARY KEY (priority, task_id)
            ) WITHOUT ROWID;
            CREATE INDEX selection_reverse_priority
                ON selection(priority DESC, task_id ASC);
            """
        )
        self.selection_count = 0

    def add_row(
        self, task_id: str, fingerprint: str, *, source: str
    ) -> bool:
        receipt = self.connection.execute(
            "INSERT OR IGNORE INTO row_fingerprints VALUES (?, ?)",
            (task_id, fingerprint),
        )
        if receipt.rowcount == 1:
            return True
        previous = self.connection.execute(
            "SELECT fingerprint FROM row_fingerprints WHERE task_id = ?", (task_id,)
        ).fetchone()
        if previous != (fingerprint,):
            raise ValueError(
                f"Duplicate {source} row identity produced conflicting content: {task_id}"
            )
        return False

    def assign_cluster(self, cluster_key: str, split: str) -> None:
        receipt = self.connection.execute(
            "INSERT OR IGNORE INTO cluster_splits VALUES (?, ?)", (cluster_key, split)
        )
        if receipt.rowcount == 1:
            return
        previous = self.connection.execute(
            "SELECT split FROM cluster_splits WHERE cluster_key = ?", (cluster_key,)
        ).fetchone()
        if previous != (split,):
            raise ValueError("A Dataset cluster was assigned to more than one split.")

    def unique_clusters(self) -> int:
        row = self.connection.execute(
            "SELECT count(*) FROM cluster_splits"
        ).fetchone()
        return row[0]

    def add_curriculum_prompt(self, prompt: str) -> bool:
        receipt = self.connection.execute(
            "INSERT OR IGNORE INTO curriculum_prompts VALUES (?)", (prompt,)
        )
        return receipt.rowcount == 1

    def select(self, priority: int, task_id: str, encoded: str, limit: int) -> None:
        # The projector combines a SHA-256 with curriculum bucket and length bits.
        # Fixed-width big-endian keys preserve integer order in the disk index.
        priority_key = priority.to_bytes(37, "big")
        if self.selection_count == limit:
            last_priority, last_id = self.connection.execute(
                "SELECT priority, task_id FROM selection "
                "ORDER BY priority DESC, task_id ASC LIMIT 1"
            ).fetchone()
            # Preserve the existing streaming selection's strict replacement rule.
            if priority_key >= last_priority:
                return
            self.connection.execute(
                "DELETE FROM selection WHERE priority = ? AND task_id = ?",
                (last_priority, last_id),
            )
        else:
            self.selection_count += 1
        self.connection.execute(
            "INSERT INTO selection VALUES (?, ?, ?)", (priority_key, task_id, encoded)
        )

    def selected_rows(self) -> Iterator[tuple[str, str]]:
        yield from self.connection.execute(
            "SELECT task_id, encoded FROM selection ORDER BY priority, task_id"
        )

    def checkpoint(self) -> None:
        self.connection.commit()


@contextmanager
def temporary_dataset_index(directory: Path) -> Iterator[DatasetIndex]:
    with TemporaryDirectory(prefix=".dataset-index-", dir=directory) as scratch:
        with closing(sqlite3.connect(Path(scratch) / "index.sqlite3")) as connection:
            connection.execute("PRAGMA cache_size = -4096")
            connection.execute("PRAGMA temp_store = FILE")
            yield DatasetIndex(connection)
