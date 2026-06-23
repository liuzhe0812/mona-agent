$path = "$env:USERPROFILE\.mona\config.json"
$json = Get-Content $path -Raw | ConvertFrom-Json
$emailIntel = [PSCustomObject]@{
    enabled = $true
    allowSearch = $true
    allowRead = $true
    allowAction = $true
    searchLimit = 50
}
if ($json.tools.PSObject.Properties.Name -contains 'emailIntel') {
    $json.tools.emailIntel = $emailIntel
} else {
    $json.tools | Add-Member -NotePropertyName 'emailIntel' -NotePropertyValue $emailIntel
}
$json | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8
Write-Host "Done: emailIntel added to config.json"
