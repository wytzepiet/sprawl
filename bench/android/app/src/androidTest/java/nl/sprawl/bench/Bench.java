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
 * bench's first four minutes. The page posts its own reports to the
 * game; `url` and `tab` come from the run (.github/workflows/bench.yml).
 */
public class Bench {
  @Test
  public void bench() throws Exception {
    UiAutomation shell = InstrumentationRegistry.getInstrumentation().getUiAutomation();
    String url = InstrumentationRegistry.getArguments().getString("url");
    String tab = InstrumentationRegistry.getArguments().getString("tab") + "-" + android.os.Build.MODEL.replaceAll("[^A-Za-z0-9]", "-");
    // The phone's own meters, every few seconds, the page's phases told by
    // the clock: energy by rail (CPU clusters, GPU, memory, display) and the
    // temperatures. First half a minute of the home screen alone, lit.
    sh(shell, "mkdir -p /sdcard/Download/bench\nsvc power stayon true\ninput keyevent KEYCODE_WAKEUP\n"
        // Energy by rail, read by Perfetto, which may read the power HAL as the shell may not.
        + "cat > /data/local/tmp/power.cfg <<'END'\n"
        + "buffers { size_kb: 16384 fill_policy: RING_BUFFER }\n"
        + "data_sources { config { name: \"android.power\" android_power_config { battery_poll_ms: 1000 collect_power_rails: true"
        + " battery_counters: BATTERY_COUNTER_CURRENT battery_counters: BATTERY_COUNTER_VOLTAGE } } }\n"
        + "duration_ms: 900000 write_into_file: true file_write_period_ms: 5000\n"
        + "END\n"
        + "perfetto --background --txt -c /data/local/tmp/power.cfg -o /data/misc/perfetto-traces/power.pftrace > /sdcard/Download/bench/perfetto.txt 2>&1\n");
    String meters = "/sdcard/Download/bench/" + tab + "-power.txt";
    long began = System.currentTimeMillis();
    for (long at = 0; at < 30_000; at += 5_000) {
      measure(shell, meters);
      Thread.sleep(Math.max(0, began + at + 5_000 - System.currentTimeMillis()));
    }
    // Chrome reads its flags from here when it is the debug app.
    sh(shell, "echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line\n"
        + "am set-debug-app --persistent com.android.chrome\n"
        + "am force-stop com.android.chrome\n"
        // Or Chrome asks for them over the page.
        + "pm grant com.android.chrome android.permission.POST_NOTIFICATIONS\n"
        + "svc power stayon true\n"
        + "am start -a android.intent.action.VIEW -d '" + url + "&tab=" + tab + "' com.android.chrome\n");
    // What the screen showed, for the run's files (bench.yml pulls this folder).
    long opened = System.currentTimeMillis();
    for (long at = 5_000; at <= 840_000; at += 5_000) {
      Thread.sleep(Math.max(0, opened + at - System.currentTimeMillis()));
      measure(shell, meters);
      if (at % 60_000 == 15_000) sh(shell, "screencap -p /sdcard/Download/bench/" + tab + "-" + at / 1000 + "s.png\n");
      if (at % 60_000 == 0) sh(shell, "cp /data/misc/perfetto-traces/power.pftrace /sdcard/Download/bench/" + tab + "-power.pftrace\n");
    }
  }

  /** One reading of every meter the shell may read, appended. */
  private static void measure(UiAutomation shell, String file) throws Exception {
    sh(shell, "{ echo \"@@ $(date +%s.%N)\"\n"
        + "echo '## thermal'; dumpsys thermalservice | grep -A40 'Current temperatures from HAL' | head -45\n"
        + "echo '## battery'; cat /sys/class/power_supply/battery/current_now /sys/class/power_supply/battery/voltage_now /sys/class/power_supply/battery/status\n"
        + "echo '## top'; top -b -n 1 -m 6 | tail -8\n"
        + "} >> " + file + " 2>&1\n");
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
