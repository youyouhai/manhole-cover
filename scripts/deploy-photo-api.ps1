param(
  [string]$EnvId = 'smart-manhole-demo-d4cxwdfdf3c12',
  [string]$Region = 'ap-shanghai',
  [ValidateSet('Deploy','Update','Check','Route','Logs','InitDb','EnvInfo')][string]$Operation = 'Deploy'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$functionDirectory = Resolve-Path (Join-Path $PSScriptRoot '..\cloudbase\functions\photo-api')
$authPath = Join-Path $env:USERPROFILE '.config\.cloudbase\auth.json'
$deviceTokenPath = Join-Path $PSScriptRoot '..\cloudbase\.photo-device-token.local.txt'
if (-not (Test-Path -LiteralPath $authPath)) { throw 'CloudBase CLI authentication is missing. Run tcb login --key.' }
if (-not (Test-Path -LiteralPath $deviceTokenPath)) { throw 'Local photo device token is missing.' }

$auth = Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json
$credential = $auth.credential
if (-not $credential.tmpSecretId -or -not $credential.tmpSecretKey -or -not $credential.tmpToken) {
  throw 'CloudBase temporary credential is incomplete. Run tcb login --key again.'
}
$deviceToken = (Get-Content -LiteralPath $deviceTokenPath -Raw).Trim()

function Get-HmacBytes([byte[]]$key, [string]$message) {
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
  try { return $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($message)) }
  finally { $hmac.Dispose() }
}

function Get-Sha256Hex([string]$value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Invoke-CloudApi([string]$service, [string]$action, [string]$version, [hashtable]$body) {
  $hostName = "$service.tencentcloudapi.com"
  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $date = [DateTimeOffset]::FromUnixTimeSeconds($timestamp).UtcDateTime.ToString('yyyy-MM-dd')
  $payload = ConvertTo-Json -InputObject $body -Depth 15 -Compress
  $canonicalHeaders = "content-type:application/json; charset=utf-8`nhost:$hostName`nx-tc-action:$($action.ToLowerInvariant())`n"
  $signedHeaders = 'content-type;host;x-tc-action'
  $canonicalRequest = "POST`n/`n`n$canonicalHeaders`n$signedHeaders`n$(Get-Sha256Hex $payload)"
  $scope = "$date/$service/tc3_request"
  $stringToSign = "TC3-HMAC-SHA256`n$timestamp`n$scope`n$(Get-Sha256Hex $canonicalRequest)"
  $dateKey = Get-HmacBytes ([Text.Encoding]::UTF8.GetBytes("TC3$($credential.tmpSecretKey)")) $date
  $serviceKey = Get-HmacBytes $dateKey $service
  $signingKey = Get-HmacBytes $serviceKey 'tc3_request'
  $signature = ([BitConverter]::ToString((Get-HmacBytes $signingKey $stringToSign))).Replace('-', '').ToLowerInvariant()
  $authorization = "TC3-HMAC-SHA256 Credential=$($credential.tmpSecretId)/$scope, SignedHeaders=$signedHeaders, Signature=$signature"
  $headers = @{
    Authorization = $authorization
    'X-TC-Action' = $action
    'X-TC-Version' = $version
    'X-TC-Timestamp' = [string]$timestamp
    'X-TC-Token' = $credential.tmpToken
  }
  if ($service -eq 'scf' -or $action -eq 'CreateTable') { $headers['X-TC-Region'] = $Region }
  $addresses = @(Resolve-DnsName $hostName -Server '223.5.5.5' -ErrorAction Stop | Where-Object { $_.Type -eq 'A' -and $_.IPAddress } | Select-Object -ExpandProperty IPAddress)
  if (-not $addresses.Count) { throw "Unable to resolve $hostName through DNS" }
  $curlArgs = @('--resolve', "$($hostName):443:$($addresses[0])", '--ssl-no-revoke', '--silent', '--show-error', '--max-time', '90', '-X', 'POST', '-H', "Authorization: $authorization", '-H', 'Content-Type: application/json; charset=utf-8', '-H', "X-TC-Action: $action", '-H', "X-TC-Version: $version", '-H', "X-TC-Timestamp: $timestamp", '-H', "X-TC-Token: $($credential.tmpToken)")
  if ($service -eq 'scf' -or $action -eq 'CreateTable') { $curlArgs += @('-H', "X-TC-Region: $Region") }
  $payloadPath = Join-Path ([IO.Path]::GetTempPath()) ("photo-api-payload-" + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    [IO.File]::WriteAllText($payloadPath, $payload, [Text.UTF8Encoding]::new($false))
    $curlArgs += @('--data-binary', "@$payloadPath", "https://$hostName/")
    $responseText = & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "$action transport failed (curl exit $LASTEXITCODE)" }
  } finally {
    if (Test-Path -LiteralPath $payloadPath) { Remove-Item -LiteralPath $payloadPath -Force }
  }
  $result = $responseText | ConvertFrom-Json
  if ($result.Response.Error) { throw "$action failed: $($result.Response.Error.Code) $($result.Response.Error.Message)" }
  return $result
}

$functionInfo = $null
try { $functionInfo = Invoke-CloudApi 'scf' 'GetFunction' '2018-04-16' @{ FunctionName = 'photo-api'; Namespace = $EnvId } }
catch { if ($_.Exception.Message -notmatch 'ResourceNotFound') { throw } }

if ($Operation -eq 'Check') {
  if (-not $functionInfo) { throw 'photo-api does not exist.' }
  Write-Output "photo-api: $($functionInfo.Response.Status) / $($functionInfo.Response.Type) / $($functionInfo.Response.Runtime)"
  $routes = Invoke-CloudApi 'tcb' 'DescribeHTTPServiceRoute' '2018-06-08' @{ EnvId = $EnvId; Limit = 100 }
  foreach ($domain in $routes.Response.Domains) {
    Write-Output "DOMAIN=$($domain.Domain) TYPE=$($domain.DomainType) DEFAULT=$($domain.IsDefault) STATUS=$($domain.Status)"
    foreach ($route in $domain.Routes) { Write-Output "  $($route.Path) => $($route.UpstreamResourceType)/$($route.UpstreamResourceName)" }
  }
  exit 0
}

if ($Operation -eq 'Logs') {
  $logs = Invoke-CloudApi 'scf' 'GetFunctionLogs' '2018-04-16' @{ FunctionName = 'photo-api'; Namespace = $EnvId; Limit = 10; Order = 'desc' }
  Write-Output "TOTAL=$($logs.Response.TotalCount) KEYS=$($logs.Response.PSObject.Properties.Name -join ',')"
  foreach ($entry in $logs.Response.Data) {
    Write-Output "REQUEST=$($entry.RequestId) TIME=$($entry.StartTime) CODE=$($entry.RetCode)"
    Write-Output $entry.Log
  }
  exit 0
}

if ($Operation -eq 'InitDb') {
  foreach ($name in @('photo_batches', 'photos', 'camera_devices')) {
    try {
      $created = Invoke-CloudApi 'tcb' 'CreateTable' '2018-06-08' @{ EnvId = $EnvId; TableName = $name; PermissionInfo = @{ AclTag = 'ADMINONLY'; EnvId = $EnvId } }
      Write-Output "CREATED=$name REQUEST=$($created.Response.RequestId)"
    } catch {
      if ($_.Exception.Message -match 'ResourceExist') { Write-Output "EXISTS=$name" }
      else { throw }
    }
  }
  exit 0
}

if ($Operation -eq 'EnvInfo') {
  $info = Invoke-CloudApi 'tcb' 'DescribeEnvs' '2018-06-08' @{ EnvId = $EnvId }
  foreach ($item in $info.Response.EnvList) {
    Write-Output "ENV=$($item.EnvId)"
    Write-Output "STATIC=$($item.StaticStorages | ConvertTo-Json -Compress -Depth 5)"
  }
  exit 0
}

if ($Operation -eq 'Route') {
  if (-not $functionInfo) { throw 'photo-api does not exist.' }
  $routes = Invoke-CloudApi 'tcb' 'DescribeHTTPServiceRoute' '2018-06-08' @{ EnvId = $EnvId; Limit = 100 }
  foreach ($domain in $routes.Response.Domains) {
    if (@($domain.Routes | Where-Object { $_.Path -eq '/photo-api' }).Count -gt 0) { throw '/photo-api route already exists; refusing to duplicate it.' }
  }
  $result = Invoke-CloudApi 'tcb' 'CreateCloudBaseGWAPI' '2018-06-08' @{ ServiceId = $EnvId; Type = 6; Path = '/photo-api'; Name = 'photo-api'; EnableUnion = $true }
  Write-Output "Created /photo-api route; RequestId=$($result.Response.RequestId)"
  exit 0
}

$archive = Join-Path ([IO.Path]::GetTempPath()) ("photo-api-" + [Guid]::NewGuid().ToString('N') + '.zip')
try {
  if ($Operation -eq 'Deploy' -and $functionInfo) { throw 'photo-api already exists; refusing to overwrite it.' }
  if ($Operation -eq 'Update' -and -not $functionInfo) { throw 'photo-api does not exist.' }
  Push-Location $functionDirectory
  try {
    Compress-Archive -Path @('scf_bootstrap','index.mjs','app.mjs','multipart.mjs','cloudbase-repository.mjs','package.json','package-lock.json') -DestinationPath $archive -CompressionLevel Optimal
  } finally { Pop-Location }
  $code = [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
  if ($Operation -eq 'Update') {
    $updated = Invoke-CloudApi 'scf' 'UpdateFunctionCode' '2018-04-16' @{
      FunctionName = 'photo-api'
      Namespace = $EnvId
      CodeSource = 'ZipFile'
      Code = @{ ZipFile = $code }
      InstallDependency = 'TRUE'
    }
    Write-Output "Updated photo-api; RequestId=$($updated.Response.RequestId)"
    exit 0
  }
  $result = Invoke-CloudApi 'scf' 'CreateFunction' '2018-04-16' @{
    FunctionName = 'photo-api'
    Namespace = $EnvId
    Stamp = 'MINI_QCBASE'
    Role = 'TCB_QcsRole'
    Type = 'HTTP'
    CodeSource = 'ZipFile'
    Code = @{ ZipFile = $code }
    Runtime = 'Nodejs20.19'
    Handler = 'index.main'
    Description = 'ESP32-S3-CAM photo collection API'
    Timeout = 30
    MemorySize = 512
    InstallDependency = 'TRUE'
    Environment = @{ Variables = @(
      @{ Key = 'CLOUDBASE_ENV_ID'; Value = $EnvId },
      @{ Key = 'PHOTO_STORAGE_PREFIX'; Value = 'photo-collection' },
      @{ Key = 'PHOTO_MAX_BYTES'; Value = '1048576' },
      @{ Key = 'PHOTO_URL_TTL_SECONDS'; Value = '900' },
      @{ Key = 'PHOTO_DEVICE_TOKENS_JSON'; Value = (ConvertTo-Json -Compress @{ 'goouuu-cam-001' = $deviceToken }) }
    ) }
  }
  Write-Output "Created photo-api; RequestId=$($result.Response.RequestId)"
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}
