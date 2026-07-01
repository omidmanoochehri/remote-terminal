# Framework-only app (no third-party deps). R8 keeps the Activity via the
# manifest, and there is no reflection on our own classes, so default rules are
# sufficient. Keep line numbers for readable release crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
