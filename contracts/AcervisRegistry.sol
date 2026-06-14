// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AcervisRegistry
 * @dev Immutable ledger for academic credential hashes on the Polygon Network.
 * Supports tiered access control (Super Admin vs Institutions).
 */
contract AcervisRegistry {
    address public superAdmin;

    enum Status { NonExistent, Active, Suspended, Revoked }

    struct Credential {
        Status status;
        uint256 anchoredAt;
        address issuedBy;
    }

    struct Institution {
        bool isAuthorized;
        uint256 quota;
        uint256 issuedCount;
        string name;
    }

    mapping(bytes32 => Credential) public registry;
    mapping(address => Institution) public institutions;

    event InstitutionAuthorized(address indexed institution, string name, uint256 quota);
    event CredentialAnchored(bytes32 indexed hash, address indexed institution);
    event CredentialStatusChanged(bytes32 indexed hash, Status newStatus);

    modifier onlySuperAdmin() {
        require(msg.sender == superAdmin, "ACV: Only Super Admin");
        _;
    }

    modifier onlyAuthorizedInstitution() {
        require(institutions[msg.sender].isAuthorized, "ACV: Unauthorized Institution");
        _;
    }

    constructor() {
        superAdmin = msg.sender;
    }

    /**
     * @dev Super Admin authorizes a new institution and sets their issuance quota.
     */
    function authorizeInstitution(address _institution, string memory _name, uint256 _quota) external onlySuperAdmin {
        institutions[_institution] = Institution(true, _quota, 0, _name);
        emit InstitutionAuthorized(_institution, _name, _quota);
    }

    /**
     * @dev Institution anchors a new credential hash. Checks against quota.
     */
    function anchorCredential(bytes32 _hash) external onlyAuthorizedInstitution {
        require(registry[_hash].status == Status.NonExistent, "ACV: Hash already anchored");
        require(institutions[msg.sender].issuedCount < institutions[msg.sender].quota, "ACV: Quota exceeded");

        registry[_hash] = Credential(Status.Active, block.timestamp, msg.sender);
        institutions[msg.sender].issuedCount++;

        emit CredentialAnchored(_hash, msg.sender);
    }

    /**
     * @dev Institution revokes a credential they issued.
     */
    function revokeCredential(bytes32 _hash) external {
        require(registry[_hash].issuedBy == msg.sender || msg.sender == superAdmin, "ACV: Unauthorized to revoke");
        registry[_hash].status = Status.Revoked;
        emit CredentialStatusChanged(_hash, Status.Revoked);
    }

    /**
     * @dev Institution suspends a credential for re-verification.
     */
    function suspendCredential(bytes32 _hash) external {
        require(registry[_hash].issuedBy == msg.sender, "ACV: Unauthorized to suspend");
        registry[_hash].status = Status.Suspended;
        emit CredentialStatusChanged(_hash, Status.Suspended);
    }

    /**
     * @dev Public verification function.
     */
    function verify(bytes32 _hash) external view returns (Status, uint256, address) {
        Credential memory cred = registry[_hash];
        return (cred.status, cred.anchoredAt, cred.issuedBy);
    }
}
