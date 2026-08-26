```markdown
gitGraph
    commit id: "c1" tag: "v0.1.0"
    branch develop
    checkout develop
    commit id: "c2"
    commit id: "c3"
    branch feature/login
    checkout feature/login
    commit id: "c4"
    commit id: "c5"
    commit id: "c6"
    checkout develop
    merge feature/login
    commit id: "c7"
    branch feature/payment
    checkout feature/payment
    commit id: "c8"
    commit id: "c9"
    commit id: "c10"
    checkout develop
    merge feature/payment
    branch "release/2.1.0"
    checkout "release/2.1.0"
    commit id: "c11"
    commit id: "c12"
    commit id: "c13"
    checkout main
    merge "release/2.1.0" tag: "v2.1.0"
    branch "hotfix/2.0.1"
    checkout "hotfix/2.0.1"
    commit id: "c14"
    checkout main
    merge "hotfix/2.0.1" tag: "v2.0.1"
    branch "feature/search"
    checkout "feature/search"
    commit id: "c15"
    commit id: "c16"
    cherry-pick id: "c14"
    checkout develop
    merge "feature/search"
```