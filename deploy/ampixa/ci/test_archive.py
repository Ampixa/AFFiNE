import io, pathlib, tarfile, tempfile, unittest
from safe_archive import validate

class ArchiveTests(unittest.TestCase):
    def archive(self, extra):
        folder=tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path=pathlib.Path(folder.name)/"bundle.tgz"
        with tarfile.open(path,"w:gz") as tar:
            for name in ("SOURCE_COMMIT","BUILD_VALIDATED","FILES.sha256","RELEASE.json","deploy.sh","app/dist/main.js"):
                m=tarfile.TarInfo("./"+name); m.size=1
                tar.addfile(m,io.BytesIO(b"x"))
            for name, kind, target in extra:
                m=tarfile.TarInfo(name)
                m.type=kind; m.linkname=target
                tar.addfile(m)
        return path
    def test_valid_release(self):
        self.assertEqual(validate(self.archive([])),6)
    def test_internal_link(self):
        self.assertEqual(validate(self.archive([("app/link",tarfile.SYMTYPE,"dist/main.js")])),6)
    def test_path_traversal(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("../escape",tarfile.REGTYPE,"")]))
    def test_absolute_path(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("/escape",tarfile.REGTYPE,"")]))
    def test_escaping_link(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("app/link",tarfile.SYMTYPE,"../../escape")]))
    def test_nested_under_link(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("app/link",tarfile.SYMTYPE,"dist"),("app/link/payload",tarfile.REGTYPE,"")]))
    def test_duplicate_path(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("app/dist/main.js",tarfile.REGTYPE,"")]))
    def test_special_file(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("device",tarfile.CHRTYPE,"")]))
    def test_hard_link(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("hard",tarfile.LNKTYPE,"app/dist/main.js")]))
    def test_transitive_escape(self):
        with self.assertRaises(ValueError):
            validate(self.archive([("a",tarfile.SYMTYPE,"."),("b",tarfile.SYMTYPE,"a/../escape")]))
if __name__=="__main__": unittest.main()
