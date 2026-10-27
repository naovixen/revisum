<#
Starts and finishes Claude Code build sessions from Windows, so the steps in START.md
don't have to be remembered. WebStorm runs it from the buttons in .run/.

  .\tools\session.ps1 start    asks which session, then opens Claude in the dev container with the filled-in prompt
  .\tools\session.ps1 finish   checks tests and code stay apart, runs npm run check in the container, then commits to main
  .\tools\session.ps1 shell    opens a bash shell in the dev container

Arguments skip the questions: start seed 0a | start tests 27 | start code 27 [tests-commit] | start review 27

For the founder only: finish commits and pushes under your own Git login. Claude must never run it.
#>
param(
    [Parameter(Position = 0)] [string] $Action,
    [Parameter(Position = 1)] [string] $Kind,
    [Parameter(Position = 2)] [string] $Target,
    [Parameter(Position = 3)] [string] $TestsCommit
)

Set-Location (Split-Path $PSScriptRoot -Parent)

$devcontainerCli = '@devcontainers/cli@0.89.0'
# Kept inside .git so git never sees it as a change.
$sessionStateFile = '.git/revisum-session'
# The same folders as TEST_SET in tools/check-tests-apart.ts, which CI uses.
$testSetFolders = @('test/', 'proofs/', 'fixtures/', 'golden/')
$seedPartTitles = @{ '0a' = 'skeleton'; '0b' = 'tests from the spikes'; '0c' = 'code from the spikes' }

function Stop-WithMessage([string] $message) {
    Write-Host $message -ForegroundColor Red
    exit 1
}

function Read-Choice([string] $question, [string] $default) {
    $answer = Read-Host "$question [$default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

function Confirm-Choice([string] $question, [bool] $defaultYes) {
    $hint = if ($defaultYes) { 'Y/n' } else { 'y/N' }
    $answer = Read-Host "$question ($hint)"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $defaultYes }
    return $answer.Trim().ToLower().StartsWith('y')
}

function Start-DockerIfNeeded {
    cmd /c 'docker info >nul 2>&1'
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host 'Starting Docker Desktop...'
    Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 5
        cmd /c 'docker info >nul 2>&1'
    } until ($LASTEXITCODE -eq 0 -or (Get-Date) -gt $deadline)
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Docker Desktop did not start within 3 minutes.' }
}

function Start-DevContainer {
    Start-DockerIfNeeded
    Write-Host 'Bringing the dev container up...'
    $output = cmd /c "npx -y $devcontainerCli up --workspace-folder . 2>&1"
    if ($LASTEXITCODE -ne 0) {
        $output | Write-Host
        Stop-WithMessage 'The dev container did not start.'
    }
}

function Invoke-InContainer([string[]] $command) {
    & npx -y $devcontainerCli exec --workspace-folder . @command
}

function Get-ResearchCommit {
    $match = Select-String -Path 'CLAUDE.md' -Pattern 'at commit `([0-9a-f]{7,40})`' | Select-Object -First 1
    if (-not $match) { Stop-WithMessage 'No research commit found under Provenance in CLAUDE.md.' }
    return $match.Matches[0].Groups[1].Value
}

function Get-SpecNumber([string] $answer) {
    if ($answer -notmatch '^\d{1,2}$') { Stop-WithMessage "'$answer' is not a spec number." }
    $number = '{0:D2}' -f [int] $answer
    $specFile = Get-ChildItem "docs/specs/SPEC-$number-*.md" | Select-Object -First 1
    if (-not $specFile) { Stop-WithMessage "No spec file docs/specs/SPEC-$number-*.md." }
    Write-Host "Spec: $($specFile.Name)"
    return $number
}

function Get-ChangedPaths {
    $lines = git status --porcelain=v1 --untracked-files=all
    foreach ($line in $lines) {
        $path = $line.Substring(3)
        # A rename shows as 'old -> new'; both sides count as changed.
        foreach ($part in ($path -split ' -> ')) { $part.Trim('"') }
    }
}

function Test-InTestSet([string] $path) {
    foreach ($folder in $testSetFolders) {
        if ($path.StartsWith($folder)) { return $true }
    }
    return $false
}

function Start-Session {
    $kind = $Kind
    if (-not $kind) {
        Write-Host '1  seed    session 0: skeleton, tests or code from the spikes'
        Write-Host '2  tests   write the tests for a spec'
        Write-Host '3  code    implement a spec against its merged tests'
        Write-Host '4  review  cold review of a merged spec (changes nothing)'
        $kind = @{ '1' = 'seed'; '2' = 'tests'; '3' = 'code'; '4' = 'review' }[(Read-Host 'Which session? 1-4')]
    }

    $placeholders = @()
    switch ($kind) {
        'seed' {
            $part = if ($Target) { $Target } else { Read-Host 'Which part? 0a, 0b or 0c' }
            if (-not $seedPartTitles.ContainsKey($part)) { Stop-WithMessage "'$part' is not 0a, 0b or 0c." }
            $promptFile = 'docs/prompts/session-00-seed.md'
            $placeholders = @("PART=$part", "COMMIT=$(Get-ResearchCommit)")
            $sessionName = "seed $part"
        }
        { $_ -in 'tests', 'code', 'review' } {
            $number = Get-SpecNumber $(if ($Target) { $Target } else { Read-Host 'Spec number' })
            $promptFile = "docs/prompts/session-$kind.md"
            $placeholders = @("NN=$number")
            $sessionName = "$kind $number"
            if ($kind -eq 'code') {
                $commit = $TestsCommit
                if (-not $commit) {
                    $latest = git log -1 --format=%h -- test fixtures golden
                    if (-not $latest) { Stop-WithMessage 'No tests commit yet. Run and finish the tests session first.' }
                    $commit = Read-Choice 'Tests commit' $latest
                }
                $placeholders += "TESTS-COMMIT=$commit"
            }
        }
        default { Stop-WithMessage "Unknown session '$kind'. Use seed, tests, code or review." }
    }

    if (Get-ChangedPaths) {
        git status --short
        if (-not (Confirm-Choice 'There are uncommitted changes. They would be committed with this session. Start anyway?' $false)) { exit 1 }
    }

    Set-Content -Path $sessionStateFile -Value $sessionName -Encoding ascii
    Start-DevContainer
    Invoke-InContainer (@('bash', 'tools/session-start.sh', $promptFile) + $placeholders)
    Write-Host ''
    Write-Host 'Claude has exited. When you are happy with the work, run finish (the Finish session button).' -ForegroundColor Cyan
}

function Complete-Session {
    $sessionName = if (Test-Path $sessionStateFile) { (Get-Content $sessionStateFile -Raw).Trim() } else { 'unknown' }
    Write-Host "Session: $sessionName"
    if ($sessionName -like 'review *') {
        Remove-Item $sessionStateFile
        Write-Host 'A review session changes nothing, so there is nothing to commit.'
        return
    }

    $changed = @(Get-ChangedPaths)
    if ($changed.Count -eq 0) { Write-Host 'Nothing to commit.'; return }

    # Tests and code are separate sessions, and CI's tests-apart job rejects a commit that mixes them.
    $testSetChanges = @($changed | Where-Object { Test-InTestSet $_ })
    $otherChanges = @($changed | Where-Object { -not (Test-InTestSet $_) })
    $testsOnly = $sessionName -like 'tests *' -or $sessionName -eq 'seed 0b'
    $codeOnly = $sessionName -like 'code *' -or $sessionName -eq 'seed 0c'
    $wrongSide = if ($testsOnly) { $otherChanges }
                 elseif ($codeOnly) { $testSetChanges }
                 elseif ($testSetChanges.Count -gt 0 -and $otherChanges.Count -gt 0) { $otherChanges }
                 else { @() }
    if ($wrongSide.Count -gt 0) {
        Write-Host 'These changes break the rule that tests and code are committed apart:' -ForegroundColor Red
        $wrongSide | ForEach-Object { Write-Host "  $_" }
        Stop-WithMessage 'Not committing. Undo them, or commit them separately by hand.'
    }

    Start-DevContainer
    Write-Host 'Running npm run check in the container...'
    Invoke-InContainer @('npm', 'run', 'check')
    if ($LASTEXITCODE -ne 0) {
        if ($sessionName -eq 'seed 0b') { Write-Host 'Expected: the 0b tests fail until session 0c adds the code.' -ForegroundColor Yellow }
        elseif ($sessionName -like 'tests *') { Write-Host 'Expected: new tests fail until the code session.' -ForegroundColor Yellow }
        if (-not (Confirm-Choice 'npm run check failed. Commit anyway?' $false)) { exit 1 }
    }

    Write-Host ''
    git status --short
    $branch = git branch --show-current
    if ($branch -ne 'main') {
        if (-not (Confirm-Choice "You are on '$branch', not main. Commit here anyway?" $false)) { exit 1 }
    }

    $defaultMessage = switch -Wildcard ($sessionName) {
        'seed *' { $part = $sessionName.Split(' ')[1]; "Session $($part): $($seedPartTitles[$part])" }
        'tests *' { "SPEC-$($sessionName.Split(' ')[1]): tests" }
        'code *' { "SPEC-$($sessionName.Split(' ')[1]): code" }
        default { '' }
    }
    $message = Read-Choice 'Commit message' $defaultMessage
    if (-not $message) { Stop-WithMessage 'A commit message is needed.' }
    if (-not (Confirm-Choice "Commit these $($changed.Count) changes to $branch?" $true)) { exit 1 }

    git add -A
    git commit -m $message
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'git commit failed.' }
    Remove-Item $sessionStateFile -ErrorAction SilentlyContinue

    if (Confirm-Choice 'Push to GitHub?' $true) {
        git push
        if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'git push failed. The commit is safe locally.' }
    }
    Write-Host 'Done. Tick the step in START.md if this finished one.' -ForegroundColor Green
}

switch ($Action) {
    'start' { Start-Session }
    'finish' { Complete-Session }
    'shell' { Start-DevContainer; Invoke-InContainer @('bash') }
    default { Stop-WithMessage 'Usage: .\tools\session.ps1 start | finish | shell' }
}
