package com.visualice.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** One WebView showing the fixture page, debuggable so Playwright can attach to it. */
public class MainActivity extends Activity {
  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    WebView.setWebContentsDebuggingEnabled(true);
    WebView view = new WebView(this);
    view.getSettings().setJavaScriptEnabled(true);
    view.getSettings().setDomStorageEnabled(true);
    view.setWebViewClient(new WebViewClient());
    setContentView(view);
    view.loadUrl("file:///android_asset/index.html");
  }
}
