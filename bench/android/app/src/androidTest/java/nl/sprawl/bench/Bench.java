package nl.sprawl.bench;

import android.app.UiAutomation;
import android.os.ParcelFileDescriptor;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import org.junit.Test;

/**
 * The bench (client/src/engine/PerfReport.tsx) on this phone: Chrome opened
 * on the game's `?bench`, past its first-run screens, and left for the
 * bench's seventy seconds and more. The page posts its own reports to the
 * game; `url` and `tab` come from the run (.github/workflows/bench.yml).
 */
public class Bench {
  @Test
  public void bench() throws Exception {
    UiAutomation shell = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    String url = InstrumentationRegistry.getArguments().getString("url");
    String tab = InstrumentationRegistry.getArguments().getString("tab") + "-" + android.os.Build.MODEL.replaceAll("[^A-Za-z0-9]", "-");
    // Chrome reads its flags from here when it is the debug app.
    sh(shell, "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line\n"
        + "am set-debug-app --persistent com.android.chrome\n"
        + "am force-stop com.android.chrome\n"
        + "svc power stayon true\n"
        + "am start -a android.intent.action.VIEW -d '" + url + "&tab=" + tab + "' com.android.chrome\n");
    Thread.sleep(110_000);
  }

  /** A script for the shell, as the shell user; executeShellCommand alone splits on spaces and quotes nothing. */
  private static void sh(UiAutomation shell, String script) throws Exception {
    ParcelFileDescriptor[] io = shell.executeShellCommandRw("sh");
    try (FileOutputStream in = new FileOutputStream(io[1].getFileDescriptor())) {
      in.write(script.getBytes());
    }
    io[1].close();
    try (FileInputStream out = new FileInputStream(io[0].getFileDescriptor())) {
      while (out.read() != -1) {}
    }
    io[0].close();
  }
}
