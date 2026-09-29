param(
    [string]$DeviceId = "MH001",
    [int]$PollSeconds = 5,
    [string]$EnvId = "smart-manhole-demo-d4cxwdfdf3c12"
)

$ErrorActionPreference = "Stop"
$cliPath = Join-Path $env:APPDATA "npm\node_modules\@cloudbase\cli\dist\standalone\cli.js"

if (-not (Test-Path -LiteralPath $cliPath)) {
    throw "CloudBase CLI was not found: $cliPath. Install and log in to tcb CLI first."
}

function Read-ExtendedNumber($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [ValueType]) { return [double]$Value }
    if ($Value.PSObject.Properties.Name -contains '$numberDouble') {
        return [double]$Value.'$numberDouble'
    }
    if ($Value.PSObject.Properties.Name -contains '$numberInt') {
        return [double]$Value.'$numberInt'
    }
    if ($Value.PSObject.Properties.Name -contains '$numberLong') {
        return [double]$Value.'$numberLong'
    }
    return [double]$Value
}

function Read-Location {
    $inner = [ordered]@{
        find = "device_locations"
        filter = @{ _id = $DeviceId }
        limit = 1
    } | ConvertTo-Json -Compress -Depth 5

    $outerItem = @{
        TableName = "device_locations"
        CommandType = "QUERY"
        Command = $inner
    } | ConvertTo-Json -Compress -Depth 5

    $commandJson = "[$outerItem]"
    $escapedCommand = $commandJson.Replace('\', '\\').Replace('"', '\"')
    $raw = (& node $cliPath db nosql execute --command $escapedCommand --json -e $EnvId 2>&1 | Out-String)
    $jsonStart = $raw.IndexOf('{')

    if ($jsonStart -lt 0) {
        throw "CloudBase did not return JSON: $raw"
    }

    $response = $raw.Substring($jsonStart) | ConvertFrom-Json
    if ($response.error) {
        throw $response.error.message
    }

    return $response.data.results[0][0]
}

$previousReceivedAt = $null
$previousLongitude = $null
$previousLatitude = $null

Write-Host "Watching $DeviceId every $PollSeconds seconds. Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "RECEIVED_AT              MODE  INT   LONGITUDE     LATITUDE      PACKET  COORD" -ForegroundColor DarkGray

while ($true) {
    try {
        $record = Read-Location
        if ($null -eq $record) {
            Write-Host "$(Get-Date -Format 'HH:mm:ss')  NO_LOCATION_RECORD" -ForegroundColor Yellow
        }
        else {
            $longitude = Read-ExtendedNumber $record.longitude
            $latitude = Read-ExtendedNumber $record.latitude
            $interval = [int](Read-ExtendedNumber $record.configuredIntervalSec)
            $receivedMs = [long](Read-ExtendedNumber $record.receivedAt.'$date')
            $receivedAt = [DateTimeOffset]::FromUnixTimeMilliseconds($receivedMs).ToLocalTime()
            $packetState = if ($null -eq $previousReceivedAt) { "FIRST" } elseif ($receivedMs -ne $previousReceivedAt) { "NEW" } else { "WAIT" }
            $coordinateState = if ($null -eq $previousLongitude) { "FIRST" } elseif ($longitude -ne $previousLongitude -or $latitude -ne $previousLatitude) { "CHANGED" } else { "SAME" }
            $color = if ($coordinateState -eq "CHANGED") { "Green" } elseif ($packetState -eq "NEW") { "Cyan" } else { "DarkGray" }

            Write-Host ("{0}  {1,-4}  {2,2}s  {3,12:F6}  {4,11:F6}  {5,-4}  {6}" -f `
                $receivedAt.ToString("yyyy-MM-dd HH:mm:ss"),
                $record.locationMode,
                $interval,
                $longitude,
                $latitude,
                $packetState,
                $coordinateState) -ForegroundColor $color

            $previousReceivedAt = $receivedMs
            $previousLongitude = $longitude
            $previousLatitude = $latitude
        }
    }
    catch {
        Write-Host "$(Get-Date -Format 'HH:mm:ss')  QUERY_FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }

    Start-Sleep -Seconds $PollSeconds
}
