package com.sparkp2p.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SparkRelayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
