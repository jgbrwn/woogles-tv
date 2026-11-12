package io.woogles.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * Woogles-TV launcher: a single full-screen WebView pointed at the TV page.
 *
 * Remote control:
 *   D-pad / OK  -> delivered to the page as normal key events (OK = Enter)
 *   Back        -> history back, else "press Back again to exit"
 *   Menu or long-press OK -> native menu (reload / change server URL)
 */
public class MainActivity extends Activity {
    static final String DEFAULT_URL = "https://woogles-tv.exe.xyz/tv?app=1";
    static final String PREFS = "woogles-tv";
    static final String PREF_URL = "server_url";
    static final long RETRY_MS = 5000;
    static final long LONG_PRESS_MS = 700;
    static final long EXIT_WINDOW_MS = 2000;

    private WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String homeUrl;          // configured start URL
    private String targetUrl;        // URL we are trying to show (retried on error)
    private boolean showingError;    // error page currently displayed
    private boolean pageFailed;      // current main-frame load failed
    private boolean clearHistoryOnLoad;
    private long lastBackAt;
    private Toast exitToast;

    // Long-press-OK tracking: we hold back the OK key-down until we know it is a short press.
    private KeyEvent pendingOkDown;
    private boolean okLongFired;

    private final Runnable retry = new Runnable() {
        @Override public void run() {
            if (showingError && web != null) {
                clearHistoryOnLoad = true;
                web.loadUrl(targetUrl);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        homeUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_URL, DEFAULT_URL);
        targetUrl = homeUrl;

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(11, 61, 58));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11, 61, 58));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setupWebView();
        enterImmersive();

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(targetUrl);
        }
        web.requestFocus();
    }

    @SuppressWarnings("deprecation")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage (room id) persists across launches
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " WooglesTV/" + appVersion());

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.addJavascriptInterface(new Bridge(), "WooglesTV");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());
    }

    /** Exposed to the page as window.WooglesTV. */
    class Bridge {
        @JavascriptInterface public String version() { return appVersion(); }
        @JavascriptInterface public String serverUrl() { return homeUrl; }
        @JavascriptInterface public void openMenu() {
            handler.post(new Runnable() { @Override public void run() { showMenu(); } });
        }
    }

    class Client extends WebViewClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (scheme.equals("http") || scheme.equals("https")) {
                String home = Uri.parse(homeUrl).getHost();
                if (home != null && home.equalsIgnoreCase(u.getHost())) return false; // stay in app
            }
            if (scheme.equals("data") || scheme.equals("about") || scheme.equals("javascript")) return false;
            // Foreign host / custom scheme: hand off if something can open it, otherwise stay in the WebView.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            } catch (ActivityNotFoundException e) {
                return !(scheme.equals("http") || scheme.equals("https"));
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (isRealUrl(url)) {
                pageFailed = false;
                targetUrl = url;
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!isRealUrl(url) || pageFailed) return;
            showingError = false;
            handler.removeCallbacks(retry);
            if (clearHistoryOnLoad) {
                clearHistoryOnLoad = false;
                view.clearHistory();   // drop error-page entries
            }
            CookieManager.getInstance().flush();
        }

        // Main-frame network errors (the API 23+ variant forwards main-frame errors here).
        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            showError(failingUrl, description);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse resp) {
            if (req.isForMainFrame() && resp.getStatusCode() >= 500) {
                showError(req.getUrl().toString(), "HTTP " + resp.getStatusCode());
            }
        }
    }

    private static boolean isRealUrl(String url) {
        return url != null && (url.startsWith("http://") || url.startsWith("https://"));
    }

    private void showError(String failingUrl, String why) {
        if (isRealUrl(failingUrl)) targetUrl = failingUrl;
        pageFailed = true;
        showingError = true;
        String html = "<!doctype html><html><head><meta name=viewport content='width=device-width'>"
                + "<style>html,body{margin:0;height:100%;background:#0b3d3a;color:#f3e6c4;"
                + "font-family:sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}"
                + "h1{font-size:2.4em;margin:.2em}p{font-size:1.3em;opacity:.85}small{opacity:.6}</style></head><body><div>"
                + "<h1>Can&rsquo;t reach Woogles-TV</h1>"
                + "<p>Retrying in <span id=s>5</span>s&hellip;</p>"
                + "<small>" + esc(targetUrl) + "<br>" + esc(why == null ? "" : why)
                + "<br><br>Press MENU (or hold OK) to change the server URL.</small>"
                + "</div><script>var n=5;setInterval(function(){if(n>1)n--;document.getElementById('s').textContent=n},1000)</script>"
                + "</body></html>";
        String data = Base64.encodeToString(html.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.NO_PADDING);
        web.loadData(data, "text/html; charset=utf-8", "base64");
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    // ---- keys --------------------------------------------------------------

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (code == KeyEvent.KEYCODE_MENU) {
            if (e.getAction() == KeyEvent.ACTION_UP) showMenu();
            return true;
        }
        if (isOk(code)) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                if (e.getRepeatCount() == 0) {
                    pendingOkDown = new KeyEvent(e);   // defer until we know it isn't a long press
                    okLongFired = false;
                } else if (!okLongFired && pendingOkDown != null
                        && e.getEventTime() - pendingOkDown.getEventTime() >= LONG_PRESS_MS) {
                    okLongFired = true;
                    pendingOkDown = null;
                    showMenu();
                }
                return true;
            }
            if (e.getAction() == KeyEvent.ACTION_UP) {
                KeyEvent down = pendingOkDown;
                pendingOkDown = null;
                if (okLongFired || down == null) { okLongFired = false; return true; }
                if (e.getEventTime() - down.getEventTime() >= LONG_PRESS_MS) { showMenu(); return true; }
                ensureWebFocus();
                super.dispatchKeyEvent(down);
                return super.dispatchKeyEvent(e);
            }
        }
        if (code != KeyEvent.KEYCODE_BACK) ensureWebFocus();
        return super.dispatchKeyEvent(e);
    }

    private void ensureWebFocus() {
        if (web != null && !web.hasFocus()) web.requestFocus();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && !showingError && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < EXIT_WINDOW_MS) {
            if (exitToast != null) exitToast.cancel();
            finish();
            return;
        }
        lastBackAt = now;
        exitToast = Toast.makeText(this, "Press Back again to exit Woogles-TV", Toast.LENGTH_SHORT);
        exitToast.show();
    }

    // ---- menu ---------------------------------------------------------------

    private AlertDialog menu;

    private void showMenu() {
        if (isFinishing() || (menu != null && menu.isShowing())) return;
        String[] items = {"Reload", "Change server URL\u2026", "Reset to default server", "Exit"};
        menu = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Woogles-TV " + appVersion() + "\n" + homeUrl)
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface d, int which) {
                        switch (which) {
                            case 0: reload(); break;
                            case 1: promptUrl(); break;
                            case 2: setHomeUrl(DEFAULT_URL); break;
                            case 3: finish(); break;
                        }
                    }
                })
                .setNegativeButton("Cancel", null)
                .create();
        menu.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override public void onDismiss(DialogInterface d) { enterImmersive(); ensureWebFocus(); }
        });
        menu.show();
    }

    private void reload() {
        handler.removeCallbacks(retry);
        if (showingError || !isRealUrl(web.getUrl())) {
            clearHistoryOnLoad = true;
            web.loadUrl(targetUrl);
        } else {
            web.reload();
        }
    }

    private void promptUrl() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        input.setText(homeUrl);
        input.setSelectAllOnFocus(true);
        FrameLayout box = new FrameLayout(this);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(input);
        final AlertDialog d = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Server URL")
                .setMessage("e.g. https://woogles-tv.exe.xyz/tv?app=1 (a bare host name also works)")
                .setView(box)
                .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface di, int which) {
                        String u = normalizeUrl(input.getText().toString());
                        if (u == null) {
                            Toast.makeText(MainActivity.this, "Invalid URL", Toast.LENGTH_SHORT).show();
                        } else {
                            setHomeUrl(u);
                        }
                    }
                })
                .setNegativeButton("Cancel", null)
                .create();
        d.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override public void onDismiss(DialogInterface di) { enterImmersive(); ensureWebFocus(); }
        });
        d.show();
        input.requestFocus();
    }

    /** "host" / "host:port" -> https://host/tv?app=1 ; full URLs kept as-is. */
    static String normalizeUrl(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty() || s.contains(" ")) return null;
        if (!s.contains("://")) {
            s = "https://" + s;
        }
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        String scheme = u.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String path = u.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) {
            s = scheme + "://" + u.getEncodedAuthority() + "/tv?app=1";
        }
        return s;
    }

    private void setHomeUrl(String u) {
        homeUrl = u;
        targetUrl = u;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_URL, u).apply();
        handler.removeCallbacks(retry);
        clearHistoryOnLoad = true;
        web.loadUrl(u);
    }

    // ---- lifecycle / misc ------------------------------------------------

    String appVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) { enterImmersive(); ensureWebFocus(); }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) { web.onResume(); web.resumeTimers(); }
        enterImmersive();
    }

    @Override
    protected void onPause() {
        if (web != null) { web.onPause(); }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null && !showingError) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
