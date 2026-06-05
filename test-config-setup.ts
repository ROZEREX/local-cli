// Imported FIRST by every test that touches config, so tests use a throwaway
// config directory instead of the real ~/.local-cli/config.json. This prevents
// the test suite from ever clobbering the user's real settings.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.LOCAL_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lcli-test-cfg-"));
