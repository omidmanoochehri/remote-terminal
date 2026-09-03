# Keep line numbers for readable release crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Custom views are inflated from layouts by class name: keep their
# (Context, AttributeSet) constructors. AGP's default rules cover this too,
# but be explicit.
-keep class com.cactus.remoteterminal.terminal.TerminalView {
    public <init>(android.content.Context, android.util.AttributeSet);
}
-keep class com.cactus.remoteterminal.terminal.ExtraKeysView {
    public <init>(android.content.Context, android.util.AttributeSet);
}
