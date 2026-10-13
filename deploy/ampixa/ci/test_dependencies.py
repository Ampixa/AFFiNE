import pathlib
import tempfile
import unittest

from prepare_dependencies import prepare


class DependencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "node_modules"
        self.source.mkdir()
        (self.source / "runtime.js").write_text("module.exports = 42")
        self.destination = self.root / "packages/backend/server/node_modules"
        self.destination.parent.mkdir(parents=True)

    def test_clean_layout(self):
        prepare(self.root)
        self.assertTrue((self.destination / "runtime.js").is_file())
        self.assertFalse((self.destination / "node_modules").exists())

    def test_ava_cache(self):
        cache = self.destination / ".cache/ava"
        cache.mkdir(parents=True)
        (cache / "compiled.js").write_text("test cache")
        prepare(self.root)
        self.assertTrue((self.destination / "runtime.js").is_file())
        self.assertFalse((self.destination / ".cache").exists())

    def test_preserves_unexpected_dependency(self):
        dependency = self.destination / "runtime-package"
        dependency.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "Unhoisted"):
            prepare(self.root)
        self.assertTrue(dependency.is_dir())
        self.assertTrue(self.source.is_dir())

    def test_does_not_follow_cache_symlink(self):
        self.destination.mkdir()
        self.destination.joinpath(".cache").symlink_to(self.source, target_is_directory=True)
        prepare(self.root)
        self.assertTrue((self.destination / "runtime.js").is_file())

    def test_rejects_destination_symlink(self):
        self.destination.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            prepare(self.root)
        self.assertTrue((self.source / "runtime.js").is_file())
