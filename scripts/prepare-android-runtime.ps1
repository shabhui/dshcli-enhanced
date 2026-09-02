param(
    [switch]$ValidateOnly,
    # Reuse the committed Termux runtime archive instead of rebuilding it. Staging
    # it needs to create symlinks, which on Windows requires an elevated shell or
    # Developer Mode. Only safe while the pinned deb list below is unchanged.
    [switch]$SkipTermuxRuntime,
    [string]$AndroidSdkRoot = $env:ANDROID_SDK_ROOT
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assets = Join-Path $repoRoot 'ZeroTermux-main\app\src\main\assets\paseo-runtime\packages'
$manifest = Join-Path $assets 'manifest.txt'
$paseoArchiveName = 'paseo-node-modules-arm64.tgz'
$paseoArchive = Join-Path $assets $paseoArchiveName
$termuxArchiveName = 'termux-node-runtime-arm64.tgz'
$termuxArchive = Join-Path $assets $termuxArchiveName
$eacArchiveName = 'eac-runtime-arm64.tgz'
$eacArchive = Join-Path $assets $eacArchiveName
$eacVersion = '5.3.1'
$eacDebName = 'Deepseek.Harness.EAC_5.3.1_amd64.deb'
$eacDebUrl = 'https://github.com/zouyuxuan122/DSH-Desktop-EAC/releases/download/v5.3.1/Deepseek.Harness.EAC_5.3.1_amd64.deb'
$eacDebSha256 = '1a72ba95042c26d06a19bc1128e674543df149fc8b47eb95e25ae708339757a1'
$eacStageScript = Join-Path $PSScriptRoot 'stage-eac-android-runtime.mjs'
$eacOverlayRoot = Join-Path $PSScriptRoot 'eac-android-overlay'
$eacOverlayHashes = @{
    'platform.js' = '3418ec87be338f3d308e6ddb782685cd48c3b9208c60028348beae3525082a5f'
    'runtime-paths.js' = '39878c97b96e78be45cf8fcac351379d7186119eef9defac99d4fc072010ef9e'
    'boot-server.js' = 'aa68714af6e2f69e18ca1d1ee0969036bbd75169e6cff52bce1d98c365897ba4'
    'credentials-version.cjs' = '014436b318088759b04776a6060499f226e3fcaa9c54d170f2a3f765b8bd6bfd'
    'android-resolve-sync.mjs' = '6003c183975b40d88364821610d30023c80087cffe9429fa4531bfd00d2b08c5'
    'resolve-sync-plan.mjs' = '96bad72d9c8a70b340a071e72e08b8de5ee4230809452e6f797c497fd5c46b79'
    'android-fs-patch.mjs' = 'a73c36f7ebe26300d5036c039c7a85f866f5dd0d2d1a783640912550d247be80'
    'android-hardlink.mjs' = '3ce401fba1849661ebfcb6d86962b181c29ba6026b30e17de86aca8ec6049763'
}
$legacyArchive = Join-Path $assets 'paseo-node-modules-arm64.tar.gz'
$legacyDebDirectory = Join-Path $assets 'deb'
$npmProject = Join-Path $PSScriptRoot 'android-runtime'
$ndkVersion = '29.0.14206865'
# Pin Windows' own bsdtar. A bare `tar.exe` resolves through PATH, and when this
# script is launched from git-bash it finds GNU tar instead, which reads the
# `D:` in an absolute archive path as a remote host and dies with
# "Cannot connect to D: resolve failed". bsdtar also handles the ustar/xz deb
# payloads this script unpacks.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (!(Test-Path -LiteralPath $tar)) {
    throw "Windows bsdtar not found at $tar"
}
$gitTar = Join-Path $env:ProgramFiles 'Git\usr\bin\tar.exe'
$eacLocalCache = 'D:\cache\eac-linux\eac-5.3.1-amd64.deb'
$legacyPackageName = 'com.termux'
$standalonePackageName = 'com.dshcli'
$latin1 = [System.Text.Encoding]::GetEncoding(28591)

if ($latin1.GetByteCount($legacyPackageName) -ne $latin1.GetByteCount($standalonePackageName)) {
    throw 'Relocated Termux package name must have the same byte length'
}

$packages = @(
    @{
        Name = 'c-ares_1.34.8_aarch64.deb'
        Path = 'pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb'
        Sha256 = '7681fc23e822d7988ba8b2adf3468f93ae68f724dda365cff1385096a9fa87e6'
    },
    @{
        Name = 'ca-certificates_2026.07.16_all.deb'
        Path = 'pool/main/c/ca-certificates/ca-certificates_1:2026.07.16_all.deb'
        Sha256 = '93dc49a8009012c29510081b8f07f30c57af9b10b1dae4f541231d8ee785b37a'
    },
    @{
        Name = 'libc++_29_aarch64.deb'
        Path = 'pool/main/libc/libc++/libc++_29_aarch64.deb'
        Sha256 = 'bb9f12113c137aa0e8513bb51cc49fe77a5ce3ca39ab9e92c57d228ecdf00222'
    },
    @{
        Name = 'libicu_78.3_aarch64.deb'
        Path = 'pool/main/libi/libicu/libicu_78.3_aarch64.deb'
        Sha256 = 'f536403f65a08fe0df6e7304184e902d54def77d5c3bd5edfd9109d57601d276'
    },
    @{
        Name = 'libsqlite_3.53.4_aarch64.deb'
        Path = 'pool/main/libs/libsqlite/libsqlite_3.53.4_aarch64.deb'
        Sha256 = '0e909ce0d50fe123305446cd22e0c5edf535d40344b9b065fbdcdee52f53198d'
    },
    @{
        Name = 'zlib_1.3.2_aarch64.deb'
        Path = 'pool/main/z/zlib/zlib_1.3.2_aarch64.deb'
        Sha256 = '75e7d0af17fcc3b40004309fdc00a1ddb9ae08346dce5e269902c34ac3966ac9'
    },
    @{
        Name = 'openssl_3.6.3_aarch64.deb'
        Path = 'pool/main/o/openssl/openssl_1:3.6.3_aarch64.deb'
        Sha256 = '86760e9ce736f463236f2c15b1eb3a3fdcfc5778d0fd7077a917448dcc90f3aa'
    },
    @{
        Name = 'nodejs-lts_24.18.0-1_aarch64.deb'
        Path = 'pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_aarch64.deb'
        Sha256 = '490f4d08c45b25a7ea7db6ee466ebb3ee61f07083260b85332704ed018f59a87'
    }
)

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-Sha512Integrity([string]$Path) {
    $hex = (Get-FileHash -Algorithm SHA512 -LiteralPath $Path).Hash
    $bytes = New-Object byte[] ($hex.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($hex.Substring($index * 2, 2), 16)
    }
    return 'sha512-' + [Convert]::ToBase64String($bytes)
}

function Get-LockPackage([string]$LockFile, [string]$PackagePath) {
    $resolved = & node.exe -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).packages[process.argv[2]].resolved" $LockFile $PackagePath
    $resolvedExitCode = $LASTEXITCODE
    $integrity = & node.exe -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).packages[process.argv[2]].integrity" $LockFile $PackagePath
    $integrityExitCode = $LASTEXITCODE
    if ($resolvedExitCode -ne 0 -or $integrityExitCode -ne 0 -or
        [string]::IsNullOrWhiteSpace($resolved) -or [string]::IsNullOrWhiteSpace($integrity)) {
        throw "Npm lock entry is missing: $PackagePath"
    }
    return [pscustomobject]@{
        resolved = [string]$resolved
        integrity = [string]$integrity
    }
}

function Stage-NpmPackageFromLock(
    [string]$LockFile,
    [string]$PackagePath,
    [string]$DownloadDirectory,
    [string]$Destination
) {
    $entry = Get-LockPackage $LockFile $PackagePath
    $archiveName = (($PackagePath -replace '^node_modules/', '') -replace '[/@]', '-') + '.tgz'
    $archive = Join-Path $DownloadDirectory $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri $entry.resolved -OutFile $archive
    if ((Get-Sha512Integrity $archive) -ne $entry.integrity) {
        throw "Downloaded npm package failed integrity verification: $PackagePath"
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & $tar -xzf $archive --strip-components 1 -C $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to extract npm package: $PackagePath"
    }
}

function Get-ArchiveJson([string]$Archive, [string]$Entry) {
    $json = (& $tar -xOf $Archive $Entry) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
        throw "Unable to read archive entry: $Entry"
    }
    try {
        return $json | ConvertFrom-Json
    } catch {
        throw "Invalid JSON in archive entry: $Entry"
    }
}

function Stage-CodexAndroidPackage(
    [string]$LockFile,
    [string]$DestinationRoot,
    [string]$Readelf
) {
    $packagePath = 'node_modules/@openai/codex-linux-arm64'
    $entry = Get-LockPackage $LockFile $packagePath
    if ([string]::IsNullOrWhiteSpace($entry.resolved) -or
        [string]::IsNullOrWhiteSpace($entry.integrity)) {
        throw "Codex Android lock metadata is incomplete: $packagePath"
    }

    $archive = Join-Path $DestinationRoot 'codex-linux-arm64.tgz'
    Invoke-WebRequest -UseBasicParsing -Uri $entry.resolved -OutFile $archive
    if ((Get-Sha512Integrity $archive) -ne $entry.integrity) {
        throw 'Downloaded Codex Android package failed npm integrity verification'
    }

    $packageDirectory = Join-Path $DestinationRoot ($packagePath -replace '/', '\')
    New-Item -ItemType Directory -Force -Path $packageDirectory | Out-Null
    & $tar -xzf $archive --strip-components 1 -C $packageDirectory
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to extract the Codex Android package'
    }

    $wrapper = Join-Path $DestinationRoot 'node_modules\@openai\codex\bin\codex.js'
    if (!(Test-Path -LiteralPath $wrapper -PathType Leaf) -or
        !(Get-Content -Raw -LiteralPath $wrapper).Contains('case "android":')) {
        throw 'Bundled Codex wrapper does not support Android'
    }

    $binary = Join-Path $packageDirectory 'vendor\aarch64-unknown-linux-musl\bin\codex'
    if (!(Test-Path -LiteralPath $binary -PathType Leaf)) {
        throw 'Bundled Codex Android binary is missing'
    }
    $programHeaders = & $Readelf -l $binary
    if ($LASTEXITCODE -ne 0 -or $programHeaders -match '\bINTERP\b') {
        throw 'Codex Android binary must be statically linked'
    }
    $dynamicSection = & $Readelf -d $binary
    if ($LASTEXITCODE -ne 0 -or $dynamicSection -match '\(NEEDED\)') {
        throw 'Codex Android binary must not require desktop Linux shared libraries'
    }
}

function Get-AsciiOccurrenceCount([string]$Text, [string]$Needle) {
    $count = 0
    $offset = 0
    while (($offset = $Text.IndexOf($Needle, $offset, [System.StringComparison]::Ordinal)) -ge 0) {
        $count++
        $offset += $Needle.Length
    }
    return $count
}

function Replace-AsciiPackageName([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $contents = $latin1.GetString($bytes)
    $count = Get-AsciiOccurrenceCount $contents $legacyPackageName
    if ($count -eq 0) { return 0 }

    $relocated = $contents.Replace($legacyPackageName, $standalonePackageName)
    $relocatedBytes = $latin1.GetBytes($relocated)
    if ($relocatedBytes.Length -ne $bytes.Length) {
        throw "Binary relocation changed the size of $Path"
    }
    [System.IO.File]::WriteAllBytes($Path, $relocatedBytes)
    return $count
}

function Assert-NoLegacyPackageName([string]$Root) {
    $legacyMatches = foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $contents = $latin1.GetString([System.IO.File]::ReadAllBytes($file.FullName))
        if ($contents.Contains($legacyPackageName)) { $file.FullName }
    }
    if ($legacyMatches) {
        throw "Legacy Termux package name remains in runtime payload: $($legacyMatches[0])"
    }
}

function Assert-RuntimePayload {
    if (Test-Path -LiteralPath $legacyArchive) {
        throw 'Legacy .tar.gz runtime asset must be removed because aapt expands it'
    }
    if ((Test-Path -LiteralPath $legacyDebDirectory) -and
        (Get-ChildItem -LiteralPath $legacyDebDirectory -Filter '*.deb' -File)) {
        throw 'Bundled .deb files must be replaced by the relocated Termux runtime archive'
    }
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw 'Runtime manifest is missing'
    }

    $assetsRoot = [System.IO.Path]::GetFullPath($assets) + [System.IO.Path]::DirectorySeparatorChar
    $records = @{}
    foreach ($line in Get-Content -LiteralPath $manifest) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
            throw "Invalid runtime manifest line: $line"
        }

        $relativePath = $Matches[2]
        $payloadPath = [System.IO.Path]::GetFullPath((Join-Path $assets $relativePath))
        if (!$payloadPath.StartsWith($assetsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Runtime manifest path escapes the package directory: $relativePath"
        }
        if (!(Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
            throw "Runtime payload is missing: $relativePath"
        }

        $actual = Get-Sha256 $payloadPath
        if ($actual -ne $Matches[1]) {
            throw "Checksum mismatch: $relativePath"
        }
        $records[$relativePath.Replace('\', '/')] = $true
    }

    if (!$records.ContainsKey($termuxArchiveName)) {
        throw "Runtime manifest entry is missing: $termuxArchiveName"
    }
    if (!$records.ContainsKey($paseoArchiveName)) {
        throw "Runtime manifest entry is missing: $paseoArchiveName"
    }
    if (!$records.ContainsKey($eacArchiveName)) {
        throw "Runtime manifest entry is missing: $eacArchiveName"
    }

    $termuxEntries = & $tar -tzf $termuxArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect $termuxArchiveName"
    }
    $normalizedTermuxEntries = $termuxEntries | ForEach-Object { $_ -replace '^\./', '' }
    $requiredTermuxEntries = @(
        'bin/node',
        'lib/libcares.so',
        'lib/libc++_shared.so',
        'lib/libcrypto.so.3',
        'lib/libssl.so.3',
        'lib/libz.so.1'
    )
    foreach ($requiredEntry in $requiredTermuxEntries) {
        if ($normalizedTermuxEntries -notcontains $requiredEntry) {
            throw "Bundled Termux runtime entry is missing: $requiredEntry"
        }
    }
    $forbiddenTermuxPrefixes = @(
        'include/',
        'share/doc/',
        'share/man/',
        'lib/cmake/',
        'lib/pkgconfig/',
        'lib/icu/',
        'share/icu/'
    )
    $forbiddenTermuxEntries = @(
        'lib/libicuio.so',
        'lib/libicuio.so.78',
        'lib/libicuio.so.78.3',
        'lib/libicutest.so',
        'lib/libicutest.so.78',
        'lib/libicutest.so.78.3',
        'lib/libicutu.so',
        'lib/libicutu.so.78',
        'lib/libicutu.so.78.3',
        'lib/libsqlite3.53.4.so',
        'lib/pkgIndex.tcl'
    )
    $nonRuntimeTermuxEntries = $normalizedTermuxEntries | Where-Object {
        $entry = $_
        ($forbiddenTermuxPrefixes | Where-Object { $entry.StartsWith($_) }) -or
            $forbiddenTermuxEntries -contains $entry
    }
    if ($nonRuntimeTermuxEntries) {
        throw "Non-runtime Termux payload is bundled: $($nonRuntimeTermuxEntries[0])"
    }

    $validationRoot = Join-Path ([System.IO.Path]::GetTempPath()) "paseo-runtime-validation-$PID-$([guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $validationRoot | Out-Null
        # Redirecting a native command's stderr into the success stream raises
        # NativeCommandError per line, which the script-wide 'Stop' preference would
        # turn into a terminating error before the exit code can be inspected.
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $extractErrors = & $tar -xzf $termuxArchive -C $validationRoot 2>&1
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($LASTEXITCODE -ne 0) {
            # Without SeCreateSymbolicLinkPrivilege bsdtar cannot materialise the
            # archive's symlinks, but it still writes every regular file and only
            # then exits nonzero. Assert-NoLegacyPackageName skips reparse points,
            # so such a run still scans every byte this check reads. Any other
            # failure means the archive really is unusable.
            $unexpected = $extractErrors | Where-Object {
                "$_" -notmatch "Can't create '.+': Invalid argument" -and
                    "$_" -notmatch 'Error exit delayed from previous errors'
            }
            if ($unexpected) {
                throw "Unable to extract $termuxArchiveName for validation: $($unexpected[0])"
            }
        }
        Assert-NoLegacyPackageName $validationRoot
    } finally {
        if (Test-Path -LiteralPath $validationRoot) {
            $resolvedValidationRoot = [System.IO.Path]::GetFullPath($validationRoot)
            $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
            if (!$resolvedValidationRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove validation directory outside the temporary root: $resolvedValidationRoot"
            }
            Remove-Item -LiteralPath $resolvedValidationRoot -Recurse -Force
        }
    }

    $paseoEntries = & $tar -tzf $paseoArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect $paseoArchiveName"
    }
    if ($paseoEntries -notcontains 'node_modules/@getpaseo/cli/bin/paseo') {
        throw 'Bundled Paseo CLI entry point is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@getpaseo/server/package.json') {
        throw 'Bundled Paseo server is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@openai/codex/bin/codex.js') {
        throw 'Bundled Codex wrapper is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex') {
        throw 'Bundled Codex Android binary is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/node-pty/prebuilds/android-arm64/pty.node') {
        throw 'Bundled Android node-pty module is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@parcel/watcher-android-arm64/watcher.node') {
        throw 'Bundled Android file watcher is missing'
    }
    # The Termux Node payload ships corepack but no npm, and corepack would go
    # to the network for pnpm. Both package managers are therefore vendored:
    # npm is mandatory (the kernel's plugin installs shell out to it), pnpm is
    # what `dsh plugin` forwards to. Assert the exact entry points the device
    # wrappers exec, so a bad assembly fails here instead of on the phone.
    if ($paseoEntries -notcontains 'node_modules/npm/bin/npm-cli.js') {
        throw 'Bundled npm is missing from the Paseo runtime payload'
    }
    if ($paseoEntries -notcontains 'node_modules/pnpm/bin/pnpm.cjs') {
        throw 'Bundled pnpm is missing from the Paseo runtime payload'
    }
    $sourceMaps = $paseoEntries | Where-Object { $_ -match '\.map$' }
    if ($sourceMaps) {
        throw "Source map is bundled in Paseo runtime: $($sourceMaps[0])"
    }

    $forbidden = $paseoEntries | Where-Object {
        $_ -match '\.(exe|dll)$' -or
        $_ -match 'node_modules/node-pty/prebuilds/(win32|darwin|linux)-' -or
        $_ -match 'node_modules/@parcel/watcher-(win32|darwin|linux|freebsd)-' -or
        $_ -match 'node_modules/@anthropic-ai/claude-agent-sdk-(win32|darwin|linux)-' -or
        $_ -match 'node_modules/sherpa-onnx-(win|linux|darwin)-'
    }
    if ($forbidden) {
        throw "Non-Android runtime payload is bundled: $($forbidden[0])"
    }
    $allowedPaseoNative = @(
        'node_modules/node-pty/prebuilds/android-arm64/pty.node',
        'node_modules/@parcel/watcher-android-arm64/watcher.node'
    )
    $unexpectedPaseoNative = $paseoEntries | Where-Object {
        $_ -match '\.node$' -and $allowedPaseoNative -notcontains $_
    }
    if ($unexpectedPaseoNative) {
        throw "Unexpected native module is bundled in Paseo runtime: $($unexpectedPaseoNative[0])"
    }

    $eacEntries = & $tar -tzf $eacArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect $eacArchiveName"
    }
    $normalizedEacEntries = $eacEntries | ForEach-Object { ($_ -replace '^\./', '').TrimEnd('/') }
    $outsideEacRoot = $normalizedEacEntries | Where-Object {
        $_ -and $_ -ne 'eac' -and !$_.StartsWith('eac/')
    }
    if ($outsideEacRoot) {
        throw "EAC archive entry is outside the eac root: $($outsideEacRoot[0])"
    }
    $requiredEacEntries = @(
        'eac/sidecar/server.js',
        'eac/sidecar/bridge.js',
        'eac/sidecar/phone-bridge.js',
        'eac/sidecar/rescue-integration.js',
        'eac/dsh-desktop/package.json',
        'eac/dsh-desktop/lib/desktop/platform.js',
        'eac/dsh-desktop/lib/desktop/runtime-paths.js',
        'eac/dsh-desktop/lib/desktop/boot-server.js',
        'eac/dsh-desktop/lib/desktop/android-resolve-sync.mjs',
        'eac/dsh-desktop/node_modules/node-pty/prebuilds/android-arm64/pty.node',
        'eac/dsh-desktop/node_modules/@koromix/koffi-android-arm64/index.cjs',
        'eac/dsh-desktop/node_modules/@img/sharp-wasm32/package.json',
        'eac/dsh-desktop/node_modules/@emnapi/runtime/package.json',
        'eac/dsh-desktop/node_modules/tslib/package.json'
    )
    foreach ($requiredEntry in $requiredEacEntries) {
        if ($normalizedEacEntries -notcontains $requiredEntry) {
            throw "Bundled EAC runtime entry is missing: $requiredEntry"
        }
    }
    $forbiddenEac = $normalizedEacEntries | Where-Object {
        $_ -match '^eac/dsh-desktop/(vendor|native)(/|$)' -or
        $_ -match '\.map$' -or
        $_ -match '^eac/dsh-desktop/node_modules/@koromix/koffi-(?!android-arm64(?:/|$))' -or
        $_ -match '^eac/dsh-desktop/node_modules/@img/sharp-(?!wasm32(?:/|$))' -or
        $_ -match '^eac/dsh-desktop/node_modules/node-addon-require-builtin-' -or
        $_ -match '^eac/dsh-desktop/node_modules/@vscode/ripgrep-' -or
        $_ -match '^eac/dsh-desktop/node_modules/@deepseek-ai/node-addon-landlock-run-' -or
        $_ -match '^eac/dsh-desktop/node_modules/node-pty/prebuilds/(?!android-arm64(?:/|$))' -or
        $_ -match '^eac/dsh-desktop/node_modules/bare-(fs|path|url)/prebuilds(/|$)'
    }
    if ($forbiddenEac) {
        throw "Non-Android EAC payload is bundled: $($forbiddenEac[0])"
    }
    $allowedEacNative = 'eac/dsh-desktop/node_modules/node-pty/prebuilds/android-arm64/pty.node'
    $eacNativeBinaries = $normalizedEacEntries | Where-Object {
        $_ -match '\.(exe|dll|pdb|node|bare)$' -or $_ -match '\.so(?:\.\d+)*$'
    }
    $unexpectedEacNative = $eacNativeBinaries | Where-Object { $_ -ne $allowedEacNative }
    if ($unexpectedEacNative) {
        throw "Unexpected native binary is bundled in EAC runtime: $($unexpectedEacNative[0])"
    }
    if ($eacNativeBinaries -notcontains $allowedEacNative) {
        throw 'Bundled EAC Android node-pty module is missing'
    }

    $eacPackage = Get-ArchiveJson $eacArchive 'eac/dsh-desktop/package.json'
    if ($eacPackage.version -ne $eacVersion) {
        throw "Unexpected EAC version in runtime archive: $($eacPackage.version)"
    }
    $eacDependencyVersions = @{
        'eac/dsh-desktop/node_modules/@img/sharp-wasm32/package.json' = '0.35.3'
        'eac/dsh-desktop/node_modules/@emnapi/runtime/package.json' = '1.11.3'
        'eac/dsh-desktop/node_modules/tslib/package.json' = '2.8.1'
        'eac/dsh-desktop/node_modules/@koromix/koffi-android-arm64/package.json' = '3.1.5'
    }
    foreach ($entry in $eacDependencyVersions.GetEnumerator()) {
        $metadata = Get-ArchiveJson $eacArchive $entry.Key
        if ($metadata.version -ne $entry.Value) {
            throw "Unexpected EAC dependency version in $($entry.Key): $($metadata.version)"
        }
    }
}

if ($ValidateOnly) {
    Assert-RuntimePayload
    Write-Host 'Android runtime payload is valid.'
    exit 0
}

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) "paseo-android-runtime-$PID-$([guid]::NewGuid().ToString('N'))"
try {
    $debDirectory = Join-Path $temporary 'deb'
    $eacDebStage = Join-Path $temporary 'eac-deb'
    $eacDeb = Join-Path $eacDebStage $eacDebName
    New-Item -ItemType Directory -Force -Path $temporary, $debDirectory, $eacDebStage | Out-Null

    $eacCacheCandidates = @()
    if (![string]::IsNullOrWhiteSpace($env:PASEO_EAC_DEB_CACHE)) {
        $eacCacheCandidates += $env:PASEO_EAC_DEB_CACHE
    }
    $eacCacheCandidates += $eacLocalCache
    $cachedEacDeb = $eacCacheCandidates | Where-Object {
        (Test-Path -LiteralPath $_ -PathType Leaf) -and (Get-Sha256 $_) -eq $eacDebSha256
    } | Select-Object -First 1
    if (![string]::IsNullOrWhiteSpace($cachedEacDeb)) {
        Copy-Item -LiteralPath $cachedEacDeb -Destination $eacDeb
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $eacDebUrl -OutFile $eacDeb
    }
    if ((Get-Sha256 $eacDeb) -ne $eacDebSha256) {
        throw "Downloaded checksum mismatch: $eacDebName"
    }

    $repository = 'https://packages-cf.termux.dev/apt/termux-main'
    foreach ($package in $packages) {
        $destination = Join-Path $debDirectory $package.Name
        $bundledSource = Join-Path $legacyDebDirectory $package.Name
        if ((Test-Path -LiteralPath $bundledSource -PathType Leaf) -and
            ((Get-Sha256 $bundledSource) -eq $package.Sha256)) {
            Copy-Item -LiteralPath $bundledSource -Destination $destination
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "$repository/$($package.Path)" -OutFile $destination
        }
        if ((Get-Sha256 $destination) -ne $package.Sha256) {
            throw "Downloaded checksum mismatch: $($package.Name)"
        }
    }

    $lockFile = Join-Path $npmProject 'package-lock.json'
    if (!(Test-Path -LiteralPath $lockFile -PathType Leaf)) {
        throw "Npm lock file is missing: $lockFile"
    }
    Copy-Item -LiteralPath (Join-Path $npmProject 'package.json') -Destination $temporary
    Copy-Item -LiteralPath $lockFile -Destination $temporary

    Push-Location $temporary
    try {
        & npm.cmd ci --ignore-scripts --omit=dev --no-audit --no-fund --os=android --cpu=arm64
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    } finally {
        Pop-Location
    }

    if ([string]::IsNullOrWhiteSpace($AndroidSdkRoot)) {
        $AndroidSdkRoot = $env:ANDROID_HOME
    }
    if ([string]::IsNullOrWhiteSpace($AndroidSdkRoot)) {
        throw 'ANDROID_SDK_ROOT or ANDROID_HOME must point to the Android SDK'
    }

    $ndkToolchain = Join-Path $AndroidSdkRoot "ndk\$ndkVersion\toolchains\llvm\prebuilt\windows-x86_64\bin"
    $clang = Join-Path $ndkToolchain 'aarch64-linux-android23-clang++.cmd'
    $readelf = Join-Path $ndkToolchain 'llvm-readelf.exe'
    if (!(Test-Path -LiteralPath $clang -PathType Leaf) -or !(Test-Path -LiteralPath $readelf -PathType Leaf)) {
        throw "Android NDK $ndkVersion is missing from $AndroidSdkRoot"
    }

    Stage-CodexAndroidPackage $lockFile $temporary $readelf

    $nodePackage = Join-Path $debDirectory 'nodejs-lts_24.18.0-1_aarch64.deb'
    $nativeStage = Join-Path $temporary '.android-native'
    $nodeData = Join-Path $nativeStage 'node-data'
    New-Item -ItemType Directory -Force -Path $nativeStage, $nodeData | Out-Null
    & $tar -xf $nodePackage -C $nativeStage
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the bundled Node.js package' }
    # Only the headers are needed (as node-gyp's nodedir for the node-pty build below).
    # Extracting the whole payload also unpacks bin/corepack, the archive's one symlink,
    # which bsdtar cannot create on Windows without SeCreateSymbolicLinkPrivilege and
    # which fails the whole run. Restricting the member pattern keeps the
    # include/node path shape the lookup below expects.
    & $tar -xf (Join-Path $nativeStage 'data.tar.xz') -C $nodeData `
        "./data/data/$legacyPackageName/files/usr/include/node"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the bundled Node.js headers' }

    $nodeInclude = Get-ChildItem -LiteralPath $nodeData -Recurse -Directory |
        Where-Object { $_.FullName -like '*\include\node' } |
        Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($nodeInclude)) {
        throw 'Bundled Node.js headers are missing'
    }

    $nodePty = Join-Path $temporary 'node_modules\node-pty'
    $nodeAddonApi = Join-Path $temporary 'node_modules\node-addon-api'
    $nodePtyPrebuilds = Join-Path $nodePty 'prebuilds'
    $nodePtyThirdParty = Join-Path $nodePty 'third_party'
    if (Test-Path -LiteralPath $nodePtyPrebuilds) {
        Remove-Item -LiteralPath $nodePtyPrebuilds -Recurse -Force
    }
    if (Test-Path -LiteralPath $nodePtyThirdParty) {
        Remove-Item -LiteralPath $nodePtyThirdParty -Recurse -Force
    }

    $androidPtyDirectory = Join-Path $nodePty 'prebuilds\android-arm64'
    $androidPty = Join-Path $androidPtyDirectory 'pty.node'
    New-Item -ItemType Directory -Force -Path $androidPtyDirectory | Out-Null
    & $clang -std=c++17 -shared -fPIC -O2 -fstack-protector-strong -pthread `
        -DNODE_GYP_MODULE_NAME=pty -DNAPI_VERSION=8 `
        "-I$nodeInclude" "-I$nodeAddonApi" `
        (Join-Path $nodePty 'src\unix\pty.cc') -o $androidPty
    if ($LASTEXITCODE -ne 0) { throw 'Unable to compile node-pty for Android arm64' }

    $dynamicSection = & $readelf -d $androidPty
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Android node-pty module' }
    if ($dynamicSection -match 'libc\.so\.6|libstdc\+\+\.so\.6|libgcc_s\.so') {
        throw 'Android node-pty module contains incompatible GNU runtime dependencies'
    }

    $nodeModules = Join-Path $temporary 'node_modules'
    Get-ChildItem -LiteralPath $nodeModules -Recurse -File -Filter '*.map' |
        Remove-Item -Force

    # pnpm vendors Windows-only fastlist helpers (x64/x86). Android cannot run
    # them and the payload guard below rejects every .exe/.dll, so drop them
    # here rather than letting assembly fail at the very last step.
    $pnpmVendor = Join-Path $nodeModules 'pnpm\dist\vendor'
    if (Test-Path -LiteralPath $pnpmVendor) {
        Get-ChildItem -LiteralPath $pnpmVendor -Recurse -File |
            Where-Object { $_.Name -match '\.(exe|dll)$' } |
            Remove-Item -Force
    }
    $reflinkScope = Join-Path $nodeModules 'pnpm\dist\node_modules\@reflink'
    if (Test-Path -LiteralPath $reflinkScope) {
        Get-ChildItem -LiteralPath $reflinkScope -Directory |
            Where-Object { $_.Name -like 'reflink-*' } |
            Remove-Item -Recurse -Force
    }

    if (!(Test-Path -LiteralPath $gitTar -PathType Leaf)) {
        throw "Git for Windows tar is required to unpack EAC: $gitTar"
    }
    if (!(Test-Path -LiteralPath $eacStageScript -PathType Leaf)) {
        throw "EAC staging helper is missing: $eacStageScript"
    }
    foreach ($overlay in $eacOverlayHashes.GetEnumerator()) {
        $overlayPath = Join-Path $eacOverlayRoot $overlay.Key
        if (!(Test-Path -LiteralPath $overlayPath -PathType Leaf) -or
            (Get-Sha256 $overlayPath) -ne $overlay.Value) {
            throw "EAC Android overlay failed checksum verification: $($overlay.Key)"
        }
    }

    $eacOuter = Join-Path $eacDebStage 'outer'
    $eacPayload = Join-Path $eacOuter 'payload'
    New-Item -ItemType Directory -Force -Path $eacOuter, $eacPayload | Out-Null
    & $tar -xf $eacDeb -C $eacOuter
    if ($LASTEXITCODE -ne 0) { throw "Unable to unpack $eacDebName" }
    Push-Location $eacOuter
    try {
        # GNU tar handles the release's Unicode member names. Keep the archive path
        # relative so the drive-letter colon is never interpreted as a remote host.
        & $gitTar -xzf 'data.tar.gz' -C 'payload' 'usr/lib/Deepseek Harness EAC'
        if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the EAC release payload' }
    } finally {
        Pop-Location
    }

    $eacSourceRoot = Join-Path $eacPayload 'usr\lib\Deepseek Harness EAC'
    $eacLockFile = Join-Path $eacSourceRoot 'dsh-desktop\package-lock.json'
    if (!(Test-Path -LiteralPath $eacLockFile -PathType Leaf)) {
        throw 'The EAC release package-lock.json is missing'
    }
    $eacDependencyDownloads = Join-Path $temporary 'eac-dependency-downloads'
    $sharpWasmRoot = Join-Path $temporary 'eac-dependencies\sharp-wasm32'
    $emnapiRuntimeRoot = Join-Path $temporary 'eac-dependencies\emnapi-runtime'
    $tslibRoot = Join-Path $temporary 'eac-dependencies\tslib'
    New-Item -ItemType Directory -Force -Path $eacDependencyDownloads | Out-Null
    Stage-NpmPackageFromLock $eacLockFile 'node_modules/@img/sharp-wasm32' `
        $eacDependencyDownloads $sharpWasmRoot
    Stage-NpmPackageFromLock $eacLockFile 'node_modules/@emnapi/runtime' `
        $eacDependencyDownloads $emnapiRuntimeRoot
    Stage-NpmPackageFromLock $eacLockFile 'node_modules/tslib' `
        $eacDependencyDownloads $tslibRoot

    $eacArchiveStage = Join-Path $temporary 'eac-archive'
    $eacStagedRoot = Join-Path $eacArchiveStage 'eac'
    New-Item -ItemType Directory -Force -Path $eacArchiveStage | Out-Null
    & node.exe $eacStageScript `
        --source $eacSourceRoot `
        --output $eacStagedRoot `
        --overlay $eacOverlayRoot `
        --android-node-modules $nodeModules `
        --sharp-wasm $sharpWasmRoot `
        --emnapi-runtime $emnapiRuntimeRoot `
        --tslib $tslibRoot
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stage the EAC Android runtime' }

    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    if (Test-Path -LiteralPath $paseoArchive) {
        Remove-Item -LiteralPath $paseoArchive -Force
    }
    & $tar -czf $paseoArchive -C $temporary node_modules
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Paseo runtime archive' }
    if (Test-Path -LiteralPath $eacArchive) {
        Remove-Item -LiteralPath $eacArchive -Force
    }
    & $tar -czf $eacArchive -C $eacArchiveStage eac
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the EAC runtime archive' }

    if ($SkipTermuxRuntime) {
        if (!(Test-Path -LiteralPath $termuxArchive -PathType Leaf)) {
            throw "-SkipTermuxRuntime needs the existing $termuxArchiveName"
        }
        Write-Host "Reusing $termuxArchiveName built from the same pinned Termux packages."
    } else {
        $termuxStage = Join-Path $temporary 'termux-prefix'
        New-Item -ItemType Directory -Path $termuxStage | Out-Null
        foreach ($package in $packages) {
            $packageStage = Join-Path $temporary "extract-$($package.Name)"
            New-Item -ItemType Directory -Path $packageStage | Out-Null
            & $tar -xf (Join-Path $debDirectory $package.Name) -C $packageStage
            if ($LASTEXITCODE -ne 0) { throw "Unable to unpack $($package.Name)" }
            # These payloads carry symlinks (libssl.so -> libssl.so.3 and friends, which
            # node resolves through DT_NEEDED). Creating them on Windows needs
            # SeCreateSymbolicLinkPrivilege, so run this from an elevated shell or with
            # Developer Mode on. Pass -SkipTermuxRuntime to reuse the committed archive
            # when only the Node payload changed.
            & $tar --strip-components 6 -xf (Join-Path $packageStage 'data.tar.xz') -C $termuxStage
            if ($LASTEXITCODE -ne 0) { throw "Unable to stage $($package.Name)" }
        }

        $runtimeDirectoriesToPrune = @(
            'include',
            'share\doc',
            'share\man',
            'lib\cmake',
            'lib\pkgconfig',
            'lib\icu',
            'share\icu'
        )
        foreach ($relativeDirectory in $runtimeDirectoriesToPrune) {
            $directoryToPrune = Join-Path $termuxStage $relativeDirectory
            if (Test-Path -LiteralPath $directoryToPrune) {
                Remove-Item -LiteralPath $directoryToPrune -Recurse -Force
            }
        }

        $runtimeFilesToPrune = @(
            'lib\libicuio.so',
            'lib\libicuio.so.78',
            'lib\libicuio.so.78.3',
            'lib\libicutest.so',
            'lib\libicutest.so.78',
            'lib\libicutest.so.78.3',
            'lib\libicutu.so',
            'lib\libicutu.so.78',
            'lib\libicutu.so.78.3',
            'lib\libsqlite3.53.4.so',
            'lib\pkgIndex.tcl'
        )
        foreach ($relativeFile in $runtimeFilesToPrune) {
            $fileToPrune = Join-Path $termuxStage $relativeFile
            if (Test-Path -LiteralPath $fileToPrune) {
                Remove-Item -LiteralPath $fileToPrune -Force
            }
        }

        $relocationCount = 0
        foreach ($file in Get-ChildItem -LiteralPath $termuxStage -Recurse -File) {
            if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $relocationCount += Replace-AsciiPackageName $file.FullName
        }
        if ($relocationCount -eq 0) {
            throw 'Official Termux package name was not found in runtime payload'
        }
        Assert-NoLegacyPackageName $termuxStage

        if (Test-Path -LiteralPath $termuxArchive) {
            Remove-Item -LiteralPath $termuxArchive -Force
        }
        & $tar --format=ustar -czf $termuxArchive -C $termuxStage .
        if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Termux Node runtime archive' }
    }
} finally {
    if (Test-Path -LiteralPath $temporary) {
        $resolvedTemporary = [System.IO.Path]::GetFullPath($temporary)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (!$resolvedTemporary.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove runtime directory outside the temporary root: $resolvedTemporary"
        }
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}

if (Test-Path -LiteralPath $legacyDebDirectory) {
    $resolvedDebDirectory = [System.IO.Path]::GetFullPath($legacyDebDirectory)
    $resolvedAssets = [System.IO.Path]::GetFullPath($assets) + [System.IO.Path]::DirectorySeparatorChar
    if (!$resolvedDebDirectory.StartsWith($resolvedAssets, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove legacy packages outside runtime assets: $resolvedDebDirectory"
    }
    Remove-Item -LiteralPath $resolvedDebDirectory -Recurse -Force
}

$manifestLines = @(
    "$(Get-Sha256 $termuxArchive)  $termuxArchiveName",
    "$(Get-Sha256 $paseoArchive)  $paseoArchiveName",
    "$(Get-Sha256 $eacArchive)  $eacArchiveName"
)
$manifestTemporary = "$manifest.tmp"
try {
    [System.IO.File]::WriteAllText(
        $manifestTemporary,
        ($manifestLines -join "`n") + "`n",
        [System.Text.Encoding]::ASCII)
    Move-Item -LiteralPath $manifestTemporary -Destination $manifest -Force
} finally {
    if (Test-Path -LiteralPath $manifestTemporary) {
        Remove-Item -LiteralPath $manifestTemporary -Force
    }
}

Assert-RuntimePayload
Write-Host 'Android runtime payload prepared and validated.'
