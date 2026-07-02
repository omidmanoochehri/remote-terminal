# Keep line numbers for readable release crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# The custom terminal view is inflated from activity_main.xml by class name, so
# keep its (Context, AttributeSet) constructor. AGP's default view rules cover
# this too, but be explicit.
-keep class com.cactus.remoteterminal.TerminalView {
    public <init>(android.content.Context, android.util.AttributeSet);
}
