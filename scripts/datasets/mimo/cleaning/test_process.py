"""An agent's output must not exhaust host memory or block both pipes."""
import os
import sys
import unittest

from process import bounded_command


class OutputBoundary(unittest.TestCase):
    def test_large_stdout_and_stderr_are_drained_with_bounded_retention(self):
        result = bounded_command([sys.executable, "-c",
            "import sys; sys.stdout.write('x' * 1000000); sys.stdout.flush(); sys.stderr.write('y' * 1000000)"],
            os.environ, 10, max_stdout=1024, max_stderr=512)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stdout), 1024)
        self.assertEqual(len(result.stderr), 512)


if __name__ == "__main__":
    unittest.main()
